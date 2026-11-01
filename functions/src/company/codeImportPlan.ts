export type CodeData = {
  action: string;
  originalCode: string;
  code: string;
  function: string;
  example: string;
};
export type CodeEntry = {id: string; data: CodeData};
export type CodeImportChange = {
  id: string;
  status: string;
  write: boolean;
  remove: boolean;
  before: CodeData | null;
  after: CodeData | null;
  source: CodeData;
};

/**
 * Plans an overlay import, including restoration of deletion markers.
 * @param {CodeEntry[]} source Private changes.
 * @param {CodeEntry[]} target Company changes.
 * @param {boolean} replace Replace the complete overlay.
 * @param {boolean} updateExisting Apply private changes to existing entries.
 * @return {object[]} Changes with before and after values.
 */
export function planCodeImport(
  source: CodeEntry[], target: CodeEntry[],
  replace: boolean, updateExisting: boolean,
): CodeImportChange[] {
  const old = new Map(target.map((entry) => [entry.id, entry]));
  const sourceIds = new Set(source.map((entry) => entry.id));
  const report: CodeImportChange[] = source.map((entry) => {
    const previous = old.get(entry.id);
    const restored = previous?.data.action === "delete" &&
      entry.data.action !== "delete";
    const different = !previous ||
      (Object.keys(entry.data) as Array<keyof CodeData>).some((key) =>
        previous.data[key] !== entry.data[key]);
    const write = !previous || restored ||
      ((replace || updateExisting) && different);
    const status = !different ? "unchanged" : !write ? "kept" :
      restored ? "restored" : !previous ? "added" : "updated";
    return {id: entry.id, status, write, remove: false,
      before: previous?.data ?? null,
      after: write ? entry.data : previous?.data ?? null,
      source: entry.data};
  });
  for (const entry of target) {
    if (!sourceIds.has(entry.id)) {
      report.push({id: entry.id, status: replace ? "removed" : "kept",
        write: false, remove: replace, before: entry.data,
        after: replace ? null : entry.data, source: entry.data});
    }
  }
  return report;
}
