import { useMemo } from 'react';
import type { Rule } from '../types';
import { analyzeIntersections, type IntersectionReport } from '../intersection';

interface Props {
  rules: Rule[];
  /** 点击见证示例：把「方法 + URL」填入模拟输入（只填入，不自动运行） */
  onFillRequest: (method: string, url: string) => void;
}

function WitnessRow({
  report,
  onFill,
}: {
  report: IntersectionReport;
  onFill: (method: string, url: string) => void;
}) {
  const { firstHit, witness } = report;
  return (
    <div className="ix-row">
      <div className="ix-pair">
        <span className="cov-rule-order">#{report.aIndex + 1}</span>
        <span className="ix-name">{report.aName}</span>
        <span className="ix-cap" aria-hidden>
          ∩
        </span>
        <span className="cov-rule-order">#{report.bIndex + 1}</span>
        <span className="ix-name">{report.bName}</span>
      </div>
      <button
        type="button"
        className="ix-witness"
        title="点击把该示例填入右侧模拟输入（不自动运行）"
        onClick={() => onFill(witness.method, witness.url)}
      >
        <span className="tag case-method">{witness.method}</span>
        <code className="ix-witness-url">{witness.url}</code>
      </button>
      <div className="ix-first">
        当前顺序先命中
        <span className="cov-rule-order">#{firstHit.index + 1}</span>
        <span className="ix-name">{firstHit.name}</span>
        {firstHit.thirdParty ? (
          <span className="tag tag-shadow">更早的第三条规则</span>
        ) : (
          <span className="tag tag-same">本对中靠前的规则</span>
        )}
      </div>
    </div>
  );
}

/**
 * 部分交集见证面板：规则表每次变更（增删、排序、字段、启停）即时重新分析
 * 全部已启用规则对；纯分析展示，不改变规则表与模拟行为。
 */
export function IntersectionPanel({ rules, onFillRequest }: Props) {
  const reports = useMemo(() => analyzeIntersections(rules), [rules]);
  const enabledCount = rules.reduce((n, r) => (r.enabled ? n + 1 : n), 0);

  return (
    <section className="panel intersection-panel">
      <div className="panel-title">
        <h2>部分交集见证</h2>
      </div>
      <p className="baseline-info">
        随规则表变更即时分析全部<strong>已启用</strong>规则对：只列出
        <strong>有共同请求、且双方都不能完整覆盖对方</strong>的规则对
        （完整覆盖导致的不可达见规则卡片的遮蔽诊断）。每对给出一条两条规则都能命中的
        示例「METHOD URL」，以及当前顺序下实际先命中的规则（可能是更早的第三条）。
        点击示例可填入右侧模拟输入；分析为纯只读，不改变规则表与模拟行为。
      </p>
      {enabledCount < 2 ? (
        <p className="empty">已启用规则不足两条，没有可分析的规则对。</p>
      ) : reports.length === 0 ? (
        <p className="empty">
          已启用规则之间没有部分交集：任意两条规则要么没有共同请求，
          要么一方完整覆盖了另一方。
        </p>
      ) : (
        <>
          <h3 className="reg-subtitle">{reports.length} 对部分交集</h3>
          {reports.map((r) => (
            <WitnessRow
              key={`${r.aRuleId}:${r.bRuleId}`}
              report={r}
              onFill={onFillRequest}
            />
          ))}
        </>
      )}
    </section>
  );
}
