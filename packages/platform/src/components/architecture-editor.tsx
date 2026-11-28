import type { Architecture, ArchitectureEdits, InferProposal } from "@voxium/core";

interface Props {
  arch: Architecture;
  /** Edits sent before, shown instead of what the architecture says. */
  edits?: ArchitectureEdits;
  /** How well the code supports each part, when it was inferred. */
  proposals?: InferProposal[];
  /** Violations each rule finds in the current code, by rule id. */
  violations?: Record<string, number>;
}

function Confidence({ of }: { of?: InferProposal }) {
  if (!of) return null;
  const cls = of.confidence >= 0.8 ? "ok" : of.confidence >= 0.5 ? "warn" : "bad";
  return (
    <div className="muted">
      <span className={`badge ${cls}`}>{(of.confidence * 100).toFixed(0)}%</span> {of.evidence}
    </div>
  );
}

/**
 * The fields of an architecture for a person to edit without client code: keep, rename and re-path each module, put the
 * layers in order by number, switch rules off or change their severity, and edit what is ignored. Fields are named by
 * position, which parseEditForm reads back. Everything from the repository is escaped by React.
 */
export function ArchitectureEditor({ arch, edits = {}, proposals = [], violations }: Props) {
  const find = (kind: InferProposal["kind"], name: string) => proposals.find((p) => p.kind === kind && p.name === name);
  const order = edits.layers ?? arch.layers;
  return (
    <>
      <h3>Modules</h3>
      <p className="muted">A file belongs to the first module, in this order, whose paths match it. One glob a line, starting with a folder name.</p>
      {Object.entries(arch.modules).map(([name, def], i) => {
        const e = (edits.modules && Object.hasOwn(edits.modules, name) && edits.modules[name]) || {};
        return (
          <fieldset className="card" key={name}>
            <label className="check">
              <input type="checkbox" name={`m${i}.keep`} defaultChecked={!e.reject} /> Keep module <code>{name}</code>
            </label>
            {def.description && <div className="muted">{def.description}</div>}
            <Confidence of={find("module", name)} />
            <label>
              Name
              <input type="text" name={`m${i}.name`} defaultValue={e.rename ?? name} maxLength={64} required />
            </label>
            <label>
              Paths
              <textarea className="mono" name={`m${i}.paths`} rows={Math.min(6, (e.paths ?? def.paths).length + 1)} defaultValue={(e.paths ?? def.paths).join("\n")} />
            </label>
          </fieldset>
        );
      })}

      <h3>Layer order</h3>
      <p className="muted">1 is the top. A layer may only import from layers below it.</p>
      <div className="editor-grid">
        {arch.layers.map((l, i) => (
          <fieldset className="card" key={l}>
            <label>
              Place of <code>{l}</code>
              <input type="number" name={`l${i}.pos`} min={1} max={arch.layers.length} defaultValue={order.indexOf(l) + 1} required />
            </label>
            <Confidence of={find("layer", l)} />
          </fieldset>
        ))}
      </div>

      <h3>Rules</h3>
      {arch.rules.map((r, i) => {
        const e = (edits.rules && Object.hasOwn(edits.rules, r.id) && edits.rules[r.id]) || {};
        const found = violations?.[r.id];
        return (
          <fieldset className="card" key={r.id}>
            <label className="check">
              <input type="checkbox" name={`r${i}.on`} defaultChecked={!e.off} /> <code>{r.id}</code> {r.description}
            </label>
            <div className="muted">{r.rationale}</div>
            {found !== undefined && <div className="muted">{found} violation(s) in the current code, recorded as baseline when blocking.</div>}
            <Confidence of={find("rule", r.id)} />
            <label>
              Severity
              <select name={`r${i}.severity`} defaultValue={e.severity ?? r.severity}>
                <option value="block">block: fails the check</option>
                <option value="warn">warn: listed, never fails</option>
              </select>
            </label>
          </fieldset>
        );
      })}

      <h3>Not checked</h3>
      <label>
        Globs of files to leave out, one a line. Files left out are not checked at all.
        <textarea className="mono" name="ignore" rows={Math.min(10, (edits.ignore ?? arch.ignore ?? []).length + 2)} defaultValue={(edits.ignore ?? arch.ignore ?? []).join("\n")} />
      </label>
    </>
  );
}
