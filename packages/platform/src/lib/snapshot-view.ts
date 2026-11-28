import type { Snapshot } from "@voxium/core";
import type { SnapshotRow } from "./store";

/** A stored snapshot's contents, or null for one that holds none (GitHub could not list the branch). */
export function snapshotData(row: SnapshotRow | null | undefined): Snapshot | null {
  if (!row) return null;
  try {
    const data = JSON.parse(row.snapshot_json) as Snapshot | null;
    return data && Array.isArray(data.modules) && Array.isArray(data.edges) ? data : null;
  } catch {
    return null;
  }
}

/** Points of a polyline for values over the width and height, the largest value at the top. */
export function polyline(values: number[], width: number, height: number, max: number): string {
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values.map((v, i) => `${(i * step).toFixed(1)},${(height - (max ? (v / max) * height : 0)).toFixed(1)}`).join(" ");
}
