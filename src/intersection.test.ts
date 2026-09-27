import { describe, expect, it } from 'vitest';
import {
  analyzeIntersections,
  buildWitness,
  intersectMethods,
  witnessHost,
  witnessPath,
  witnessQuery,
} from './intersection';
import { findMatch, simulate } from './engine';
import type { QueryCondition, Rule } from './types';

function rule(partial: Partial<Rule> & { id: string }): Rule {
  return {
    name: partial.id,
    enabled: true,
    method: 'ANY',
    host: 'example.com',
    pathTemplate: '/',
    query: [],
    action: { type: 'rewrite', target: '/', status: 302 },
    ...partial,
  };
}

function cond(partial: Partial<QueryCondition> & { name: string }): QueryCondition {
  return { op: 'exists', value: '', ...partial };
}

/** 用引擎语义验证某条规则是否命中给定请求 */
function matches(rule: Rule, method: string, url: string): boolean {
  return findMatch([rule], method, new URL(url)) !== null;
}

describe('intersectMethods', () => {
  it('ANY 与任何方法相交于该方法', () => {
    expect(intersectMethods('ANY', 'GET')).toBe('GET');
    expect(intersectMethods('POST', 'ANY')).toBe('POST');
    expect(intersectMethods('ANY', 'ANY')).toBe('ANY');
  });

  it('具体方法仅相同才有交集', () => {
    expect(intersectMethods('GET', 'GET')).toBe('GET');
    expect(intersectMethods('GET', 'POST')).toBeNull();
  });
});

describe('witnessHost', () => {
  it('* 与任意模式相交于另一侧的见证', () => {
    expect(witnessHost('*', '*')).toBe('example.com');
    expect(witnessHost('*', 'api.example.com')).toBe('api.example.com');
    expect(witnessHost('api.example.com', '*')).toBe('api.example.com');
  });

  it('通配子域取至少一级子域', () => {
    expect(witnessHost('*.example.com', '*.example.com')).toBe('a.example.com');
    expect(witnessHost('*.example.com', '*')).toBe('a.example.com');
  });

  it('通配子域与具体主机：具体主机落在通配范围内才有交集', () => {
    expect(witnessHost('*.example.com', 'api.example.com')).toBe('api.example.com');
    // 裸域不在通配子域范围内
    expect(witnessHost('*.example.com', 'example.com')).toBeNull();
    expect(witnessHost('*.example.com', 'other.com')).toBeNull();
  });

  it('不同层级的通配子域：取更具体一侧的见证', () => {
    const w = witnessHost('*.example.com', '*.sub.example.com');
    expect(w).toBe('a.sub.example.com');
    expect(witnessHost('*.example.com', '*.other.com')).toBeNull();
  });

  it('具体主机仅相同（忽略大小写）才有交集', () => {
    expect(witnessHost('API.example.com', 'api.example.com')).toBe('api.example.com');
    expect(witnessHost('a.com', 'b.com')).toBeNull();
  });

  it('空主机模式匹配不到请求，无交集', () => {
    expect(witnessHost('', 'example.com')).toBeNull();
    expect(witnessHost('*', '')).toBeNull();
  });
});

describe('witnessPath', () => {
  it('空值或 * 与另一侧相交于另一侧的见证', () => {
    expect(witnessPath('', '')).toBe('/');
    expect(witnessPath('*', '/users/:id')).toBe('/users/id');
    expect(witnessPath('/users/:id', '')).toBe('/users/id');
  });

  it('路径参数与字面段相容：取字面值', () => {
    expect(witnessPath('/users/:id', '/users/42')).toBe('/users/42');
    expect(witnessPath('/users/list', '/users/:id')).toBe('/users/list');
  });

  it('两个参数段相容：取一侧参数名作为具体值', () => {
    expect(witnessPath('/a/:x', '/a/:y')).toBe('/a/x');
  });

  it('字面段仅与相同字面值相容（对百分号编码宽容）', () => {
    expect(witnessPath('/users/list', '/users/list')).toBe('/users/list');
    expect(witnessPath('/users/list', '/users/detail')).toBeNull();
    expect(witnessPath('/a%20b/:x', '/a b/1')).toBe('/a%20b/1');
  });

  it('段数不一致无交集', () => {
    expect(witnessPath('/users/:id', '/users/42/extra')).toBeNull();
    expect(witnessPath('/a/:x/extra', '/a/:x')).toBeNull();
  });

  it('含空名参数段的模板永不命中，无交集', () => {
    expect(witnessPath('/:/x', '/a/x')).toBeNull();
    expect(witnessPath('', '/:/x')).toBeNull();
  });
});

describe('witnessQuery', () => {
  it('双方都无条件：空查询串', () => {
    expect(witnessQuery([], [])).toBe('');
  });

  it('「存在」补一个空值参数', () => {
    expect(witnessQuery([cond({ name: 'debug' })], [])).toBe('debug=');
  });

  it('不同 equals 值用同名重复参数同时满足', () => {
    const q = witnessQuery(
      [cond({ name: 'env', op: 'equals', value: 'canary' })],
      [cond({ name: 'env', op: 'equals', value: 'prod' })],
    );
    expect(q).toBe('env=canary&env=prod');
  });

  it('相同 equals 值只出现一次；存在被 equals 蕴含', () => {
    expect(
      witnessQuery(
        [cond({ name: 'env', op: 'equals', value: 'canary' })],
        [cond({ name: 'env', op: 'equals', value: 'canary' })],
      ),
    ).toBe('env=canary');
    expect(
      witnessQuery(
        [cond({ name: 'debug' })],
        [cond({ name: 'debug', op: 'equals', value: '1' })],
      ),
    ).toBe('debug=1');
  });

  it('not-exists 与要求出现的条件冲突时判无交集', () => {
    expect(
      witnessQuery([cond({ name: 'token', op: 'not-exists' })], [cond({ name: 'token' })]),
    ).toBeNull();
    expect(
      witnessQuery(
        [cond({ name: 'token', op: 'not-exists' })],
        [cond({ name: 'token', op: 'equals', value: 'x' })],
      ),
    ).toBeNull();
  });

  it('仅 not-exists 时参数不出现即可', () => {
    expect(
      witnessQuery([cond({ name: 'token', op: 'not-exists' })], []),
    ).toBe('');
    // 不相关的参数名互不影响
    expect(
      witnessQuery(
        [cond({ name: 'token', op: 'not-exists' })],
        [cond({ name: 'debug' })],
      ),
    ).toBe('debug=');
  });
});

describe('buildWitness', () => {
  it('四个维度分别求交后拼成两条规则都能命中的 METHOD URL', () => {
    const a = rule({
      id: 'a',
      method: 'GET',
      host: '*.example.com',
      pathTemplate: '/users/:id',
      query: [cond({ name: 'env', op: 'equals', value: 'canary' })],
    });
    const b = rule({
      id: 'b',
      method: 'ANY',
      host: 'api.example.com',
      pathTemplate: '/users/list',
      query: [cond({ name: 'debug' })],
    });
    const w = buildWitness(a, b);
    expect(w).not.toBeNull();
    expect(w!.method).toBe('GET');
    expect(w!.url).toBe('http://api.example.com/users/list?env=canary&debug=');
    expect(matches(a, w!.method, w!.url)).toBe(true);
    expect(matches(b, w!.method, w!.url)).toBe(true);
  });

  it('交集方法为 ANY 时用 GET 作为代表', () => {
    const w = buildWitness(rule({ id: 'a' }), rule({ id: 'b', method: 'ANY' }));
    expect(w).not.toBeNull();
    expect(w!.method).toBe('GET');
  });

  it('任一维度无交集即返回 null', () => {
    expect(
      buildWitness(rule({ id: 'a', method: 'GET' }), rule({ id: 'b', method: 'POST' })),
    ).toBeNull();
    expect(
      buildWitness(rule({ id: 'a', host: 'a.com' }), rule({ id: 'b', host: 'b.com' })),
    ).toBeNull();
    expect(
      buildWitness(
        rule({ id: 'a', pathTemplate: '/x/:id' }),
        rule({ id: 'b', pathTemplate: '/y/:id' }),
      ),
    ).toBeNull();
    expect(
      buildWitness(
        rule({ id: 'a', query: [cond({ name: 't', op: 'not-exists' })] }),
        rule({ id: 'b', query: [cond({ name: 't' })] }),
      ),
    ).toBeNull();
  });

  it('无法构成合法 URL 的主机模式不产出见证', () => {
    const w = buildWitness(
      rule({ id: 'a', host: 'foo bar' }),
      rule({ id: 'b', host: 'foo bar' }),
    );
    expect(w).toBeNull();
  });
});

describe('analyzeIntersections', () => {
  it('报告部分交集规则对：见证、双方与当前顺序下的先命中规则', () => {
    const rules = [
      rule({
        id: 'gray',
        name: '灰度 env=canary',
        host: 'api.example.com',
        pathTemplate: '/users/:id',
        query: [cond({ name: 'env', op: 'equals', value: 'canary' })],
      }),
      rule({
        id: 'debug',
        name: '调试开关',
        host: 'api.example.com',
        pathTemplate: '/users/:id',
        query: [cond({ name: 'debug' })],
      }),
    ];
    const reports = analyzeIntersections(rules);
    expect(reports).toHaveLength(1);
    const r = reports[0];
    expect(r.aRuleId).toBe('gray');
    expect(r.bRuleId).toBe('debug');
    expect(r.aIndex).toBe(0);
    expect(r.bIndex).toBe(1);
    expect(r.witness.url).toBe('http://api.example.com/users/id?env=canary&debug=');
    // 两条规则都能命中见证
    expect(matches(rules[0], r.witness.method, r.witness.url)).toBe(true);
    expect(matches(rules[1], r.witness.method, r.witness.url)).toBe(true);
    // 当前顺序下先命中本对中靠前的 gray
    expect(r.firstHit.ruleId).toBe('gray');
    expect(r.firstHit.index).toBe(0);
    expect(r.firstHit.thirdParty).toBe(false);
  });

  it('先命中规则可能是本对之外更早的第三条', () => {
    const rules = [
      rule({ id: 'catch-all', name: '兜底', host: 'api.example.com', pathTemplate: '' }),
      rule({
        id: 'gray',
        host: 'api.example.com',
        pathTemplate: '/users/:id',
        query: [cond({ name: 'env', op: 'equals', value: 'canary' })],
      }),
      rule({
        id: 'debug',
        host: 'api.example.com',
        pathTemplate: '/users/:id',
        query: [cond({ name: 'debug' })],
      }),
    ];
    const reports = analyzeIntersections(rules);
    // 兜底规则完整覆盖另外两条 → 涉及它的对都不报告；只剩 gray ∩ debug
    expect(reports).toHaveLength(1);
    const r = reports[0];
    expect(r.aRuleId).toBe('gray');
    expect(r.bRuleId).toBe('debug');
    expect(r.firstHit.ruleId).toBe('catch-all');
    expect(r.firstHit.index).toBe(0);
    expect(r.firstHit.thirdParty).toBe(true);
    // 用 simulate 复核：第一步命中的确实是兜底规则
    const sim = simulate(rules, r.witness.method, r.witness.url);
    expect(sim.steps[0].rule.id).toBe('catch-all');
  });

  it('任一方完整覆盖对方的规则对不报告（两个方向）', () => {
    const wide = rule({ id: 'wide', host: 'api.example.com', pathTemplate: '/users/:id' });
    const narrow = rule({
      id: 'narrow',
      host: 'api.example.com',
      pathTemplate: '/users/:id',
      query: [cond({ name: 'env', op: 'equals', value: 'canary' })],
    });
    expect(analyzeIntersections([wide, narrow])).toEqual([]);
    expect(analyzeIntersections([narrow, wide])).toEqual([]);
  });

  it('没有共同请求的规则对不报告', () => {
    const rules = [
      rule({ id: 'a', host: 'a.com', pathTemplate: '/x' }),
      rule({ id: 'b', host: 'b.com', pathTemplate: '/x' }),
      rule({ id: 'c', method: 'GET', host: 'a.com', pathTemplate: '/x' }),
      rule({ id: 'd', method: 'POST', host: 'a.com', pathTemplate: '/x' }),
    ];
    expect(analyzeIntersections(rules)).toEqual([]);
  });

  it('不同 equals 值的部分交集：见证用同名重复参数同时满足两侧', () => {
    const rules = [
      rule({
        id: 'canary',
        host: 'api.example.com',
        pathTemplate: '/users/:id',
        query: [cond({ name: 'env', op: 'equals', value: 'canary' })],
      }),
      rule({
        id: 'prod',
        host: 'api.example.com',
        pathTemplate: '/users/:id',
        query: [cond({ name: 'env', op: 'equals', value: 'prod' })],
      }),
    ];
    const reports = analyzeIntersections(rules);
    expect(reports).toHaveLength(1);
    expect(reports[0].witness.url).toBe(
      'http://api.example.com/users/id?env=canary&env=prod',
    );
    expect(matches(rules[0], reports[0].witness.method, reports[0].witness.url)).toBe(true);
    expect(matches(rules[1], reports[0].witness.method, reports[0].witness.url)).toBe(true);
  });

  it('not-exists 与要求出现的条件冲突：无交集不报告', () => {
    const rules = [
      rule({
        id: 'no-token',
        host: 'api.example.com',
        query: [cond({ name: 'token', op: 'not-exists' })],
      }),
      rule({
        id: 'has-token',
        host: 'api.example.com',
        query: [cond({ name: 'token' })],
      }),
    ];
    expect(analyzeIntersections(rules)).toEqual([]);
  });

  it('通配子域与具体主机的部分交集：见证取具体主机', () => {
    const rules = [
      rule({
        id: 'wild',
        host: '*.example.com',
        pathTemplate: '/assets/:file',
        query: [cond({ name: 'v', op: 'equals', value: '2' })],
      }),
      rule({
        id: 'exact',
        host: 'img.example.com',
        pathTemplate: '/assets/:file',
        query: [],
      }),
    ];
    const reports = analyzeIntersections(rules);
    expect(reports).toHaveLength(1);
    expect(reports[0].witness.url).toBe('http://img.example.com/assets/file?v=2');
  });

  it('路径参数与字面段的部分交集：见证取字面段', () => {
    const rules = [
      rule({
        id: 'param',
        host: 'api.example.com',
        pathTemplate: '/users/:id',
        query: [cond({ name: 'env', op: 'equals', value: 'canary' })],
      }),
      rule({
        id: 'literal',
        host: 'api.example.com',
        pathTemplate: '/users/list',
        query: [],
      }),
    ];
    const reports = analyzeIntersections(rules);
    expect(reports).toHaveLength(1);
    expect(reports[0].witness.url).toBe('http://api.example.com/users/list?env=canary');
  });

  it('停用规则不参与分析：既不成对也不拦截见证', () => {
    const rules = [
      rule({ id: 'off', enabled: false, host: 'api.example.com', pathTemplate: '' }),
      rule({
        id: 'gray',
        host: 'api.example.com',
        pathTemplate: '/users/:id',
        query: [cond({ name: 'env', op: 'equals', value: 'canary' })],
      }),
      rule({
        id: 'debug',
        host: 'api.example.com',
        pathTemplate: '/users/:id',
        query: [cond({ name: 'debug' })],
      }),
    ];
    const reports = analyzeIntersections(rules);
    expect(reports).toHaveLength(1);
    // 停用的兜底规则不拦截：先命中的就是本对中靠前的 gray
    expect(reports[0].firstHit.ruleId).toBe('gray');
    expect(reports[0].firstHit.thirdParty).toBe(false);
  });

  it('已启用规则不足两条时没有报告', () => {
    expect(analyzeIntersections([])).toEqual([]);
    expect(analyzeIntersections([rule({ id: 'only' })])).toEqual([]);
    expect(
      analyzeIntersections([
        rule({ id: 'on' }),
        rule({ id: 'off', enabled: false }),
      ]),
    ).toEqual([]);
  });

  it('分析不修改规则表（纯函数）', () => {
    const rules = [
      rule({
        id: 'gray',
        host: 'api.example.com',
        pathTemplate: '/users/:id',
        query: [cond({ name: 'env', op: 'equals', value: 'canary' })],
      }),
      rule({
        id: 'debug',
        host: 'api.example.com',
        pathTemplate: '/users/:id',
        query: [cond({ name: 'debug' })],
      }),
    ];
    const snapshot = JSON.stringify(rules);
    analyzeIntersections(rules);
    expect(JSON.stringify(rules)).toBe(snapshot);
  });
});
