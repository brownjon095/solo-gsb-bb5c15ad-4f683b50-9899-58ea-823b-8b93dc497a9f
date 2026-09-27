import type { MethodMatcher, QueryCondition, Rule } from './types';
import { findMatch, matchHost, matchPath, matchQuery } from './engine';
import { ruleCovers } from './shadow';

/**
 * 部分交集见证（纯分析，不参与模拟执行）：
 * 对全部已启用规则两两求交——方法、主机、路径段、查询条件四个维度都存在
 * 共同请求，且双方都不能完整覆盖对方（完整覆盖属于遮蔽诊断的范畴）——
 * 则为该规则对生成一条两条规则都能命中的「METHOD URL」见证，
 * 并指出当前规则顺序下实际先命中的规则（可能是本对之外的更早第三条）。
 */

/** 方法求交：ANY 与任何方法相交于该方法；两个具体方法仅相同才有交集 */
export function intersectMethods(
  a: MethodMatcher,
  b: MethodMatcher,
): MethodMatcher | null {
  if (a === 'ANY') return b;
  if (b === 'ANY') return a;
  return a === b ? a : null;
}

/**
 * 主机模式的代表见证：
 * - `*` → 任意具体主机（example.com）；
 * - `*.example.com` → 至少一级子域，取一级子域 a.example.com；
 * - 具体主机 → 其自身（小写）。
 * 空模式匹配不到任何请求，返回 null。
 */
function canonicalHost(pattern: string): string | null {
  const p = pattern.trim().toLowerCase();
  if (p === '') return null;
  if (p === '*') return 'example.com';
  if (p.startsWith('*.')) return `a.${p.slice(2)}`;
  return p;
}

/**
 * 主机求交：返回一个两个模式都能匹配的具体主机；无交集返回 null。
 * 两个候选代表（各自模式的见证）足以判定：通配子域与具体主机、
 * 或与更深层通配子域相交时，更具体一侧的见证必然同时命中另一侧。
 */
export function witnessHost(patternA: string, patternB: string): string | null {
  const ha = canonicalHost(patternA);
  const hb = canonicalHost(patternB);
  if (ha === null || hb === null) return null;
  for (const h of [ha, hb]) {
    if (matchHost(patternA, h) && matchHost(patternB, h)) return h;
  }
  return null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

type PathSeg = { kind: 'param'; name: string } | { kind: 'literal'; value: string };

/**
 * 与 matchPath 一致地按 `/` 分段（忽略空段；字面段按解码后原文比较）。
 * 返回 null 表示模板含空名参数段（`:`），按引擎语义永不命中。
 */
function parsePathSegs(template: string): PathSeg[] | null {
  const segs: PathSeg[] = [];
  for (const raw of template.split('/')) {
    if (raw === '') continue;
    if (raw.startsWith(':')) {
      const name = raw.slice(1);
      if (name === '') return null;
      segs.push({ kind: 'param', name });
    } else {
      segs.push({ kind: 'literal', value: safeDecode(raw) });
    }
  }
  return segs;
}

function isAnyPath(template: string): boolean {
  const t = template.trim();
  return t === '' || t === '*';
}

/** 把具体段序列渲染为 URL 路径（逐段编码；空序列即根路径） */
function renderPath(segs: PathSeg[]): string {
  if (segs.length === 0) return '/';
  return (
    '/' +
    segs
      .map((s) => encodeURIComponent(s.kind === 'literal' ? s.value : s.name))
      .join('/')
  );
}

/**
 * 路径求交：返回一条两个模板都能匹配的具体路径；无交集返回 null。
 * - 任一侧为空值 / `*`（任意路径）时，交集即另一侧的见证；
 * - 两侧都是具体模板时段数必须一致，逐段求交：
 *   字面段仅与相同字面值相容；参数段与字面段相容（取字面值），
 *   参数段与参数段相容（取一侧参数名作为具体值）。
 */
export function witnessPath(templateA: string, templateB: string): string | null {
  const aAny = isAnyPath(templateA);
  const bAny = isAnyPath(templateB);
  if (aAny && bAny) return '/';
  if (aAny) {
    const segs = parsePathSegs(templateB);
    return segs === null ? null : renderPath(segs);
  }
  if (bAny) {
    const segs = parsePathSegs(templateA);
    return segs === null ? null : renderPath(segs);
  }
  const sa = parsePathSegs(templateA);
  const sb = parsePathSegs(templateB);
  if (sa === null || sb === null) return null;
  if (sa.length !== sb.length) return null;
  const out: PathSeg[] = [];
  for (let i = 0; i < sa.length; i++) {
    const x = sa[i];
    const y = sb[i];
    if (x.kind === 'literal' && y.kind === 'literal') {
      if (x.value !== y.value) return null;
      out.push(x);
    } else if (x.kind === 'literal') {
      out.push(x); // 参数段与字面段相容：取字面值
    } else if (y.kind === 'literal') {
      out.push(y);
    } else {
      out.push(x); // 两个参数段：取一侧参数名作为具体值
    }
  }
  return renderPath(out);
}

/**
 * 查询条件求交：返回一个同时满足两条规则全部条件的查询串
 * （不含 `?`，空串表示无需任何参数）；条件冲突返回 null。
 * 按参数名聚合两侧条件：
 * - 「不存在」与任何要求出现的条件（存在 / 值等于）冲突 → 无交集；
 * - 不同的「值等于」用同名重复参数同时满足（`?x=a&x=b` 两侧都命中）；
 * - 仅有「存在」时补一个空值参数。
 */
export function witnessQuery(
  condsA: QueryCondition[],
  condsB: QueryCondition[],
): string | null {
  const byName = new Map<string, QueryCondition[]>();
  for (const cond of [...condsA, ...condsB]) {
    const list = byName.get(cond.name);
    if (list) list.push(cond);
    else byName.set(cond.name, [cond]);
  }
  const params = new URLSearchParams();
  for (const [name, conds] of byName) {
    const forbidden = conds.some((c) => c.op === 'not-exists');
    const equalsValues = [
      ...new Set(conds.filter((c) => c.op === 'equals').map((c) => c.value)),
    ];
    const required = equalsValues.length > 0 || conds.some((c) => c.op === 'exists');
    if (forbidden && required) return null;
    if (forbidden) continue; // 参数不出现即可满足
    if (equalsValues.length > 0) {
      // 同名重复参数：每个被要求出现的值各出现一次
      for (const v of equalsValues) params.append(name, v);
    } else if (required) {
      params.append(name, '');
    }
  }
  return params.toString();
}

/** 一条可展示的示例请求（两条规则都能命中） */
export interface WitnessRequest {
  method: string;
  url: string;
}

/** 与 findMatch 的单规则判定一致（不检查 enabled，由调用方保证规则已启用） */
function ruleMatches(rule: Rule, method: string, url: URL): boolean {
  if (rule.method !== 'ANY' && rule.method !== method.toUpperCase()) return false;
  if (!matchHost(rule.host, url.hostname)) return false;
  if (matchPath(rule.pathTemplate, url.pathname) === null) return false;
  return matchQuery(rule.query ?? [], url.searchParams);
}

/**
 * 为两条规则构造共同见证：四个维度分别求交后拼成「METHOD URL」，
 * 最后用引擎的匹配语义回验——任一规则不命中即视为无交集
 * （宁可不展示，也不展示不可靠的见证）。
 */
export function buildWitness(ruleA: Rule, ruleB: Rule): WitnessRequest | null {
  const m = intersectMethods(ruleA.method, ruleB.method);
  if (m === null) return null;
  // 请求必须有确定方法：交集为 ANY 时取 GET 作为代表
  const method = m === 'ANY' ? 'GET' : m;
  const host = witnessHost(ruleA.host, ruleB.host);
  if (host === null) return null;
  const path = witnessPath(ruleA.pathTemplate, ruleB.pathTemplate);
  if (path === null) return null;
  const query = witnessQuery(ruleA.query ?? [], ruleB.query ?? []);
  if (query === null) return null;
  let url: URL;
  try {
    url = new URL(`http://${host}${path}${query === '' ? '' : `?${query}`}`);
  } catch {
    return null;
  }
  if (!ruleMatches(ruleA, method, url) || !ruleMatches(ruleB, method, url)) {
    return null;
  }
  return { method, url: url.toString() };
}

/** 一条「部分交集」见证报告 */
export interface IntersectionReport {
  aRuleId: string;
  bRuleId: string;
  /** 两条规则在完整规则表中的下标（aIndex < bIndex） */
  aIndex: number;
  bIndex: number;
  aName: string;
  bName: string;
  witness: WitnessRequest;
  /** 当前顺序下对该见证请求实际首个命中的规则 */
  firstHit: {
    ruleId: string;
    /** 在完整规则表中的下标 */
    index: number;
    name: string;
    /** true 表示首个命中的是本对之外的更早规则 */
    thirdParty: boolean;
  };
}

/**
 * 分析整张规则表：仅已启用规则参与；对每一对（按表顺序 i < j）：
 * 1. 任一方完整覆盖对方 → 跳过（那属于遮蔽诊断，不是「部分」交集）；
 * 2. 构造不出共同见证（某维度无交集）→ 跳过；
 * 3. 否则记录见证，并用 findMatch 在完整规则表上求当前顺序下的实际首命中
 *    （可能是本对中靠前的一条，也可能是更早的第三条已启用规则）。
 * 纯函数：不修改规则表，也不影响模拟行为。
 */
export function analyzeIntersections(rules: Rule[]): IntersectionReport[] {
  const enabled: { rule: Rule; index: number }[] = [];
  rules.forEach((rule, index) => {
    if (rule.enabled) enabled.push({ rule, index });
  });

  const reports: IntersectionReport[] = [];
  for (let i = 0; i < enabled.length; i++) {
    for (let j = i + 1; j < enabled.length; j++) {
      const a = enabled[i];
      const b = enabled[j];
      // 只保留「部分」交集：任一方完整覆盖对方时不报告
      if (ruleCovers(a.rule, b.rule) || ruleCovers(b.rule, a.rule)) continue;
      const witness = buildWitness(a.rule, b.rule);
      if (witness === null) continue;
      const hit = findMatch(rules, witness.method, new URL(witness.url));
      // 见证已回验规则 a 命中，findMatch 必有结果；兜底防御
      if (hit === null) continue;
      reports.push({
        aRuleId: a.rule.id,
        bRuleId: b.rule.id,
        aIndex: a.index,
        bIndex: b.index,
        aName: a.rule.name,
        bName: b.rule.name,
        witness,
        firstHit: {
          ruleId: hit.rule.id,
          index: hit.index,
          name: hit.rule.name,
          thirdParty: hit.index !== a.index,
        },
      });
    }
  }
  return reports;
}
