// Kuhn-Munkres (Hungarian) algorithm for the rectangular assignment problem
// (minimize total cost). O(n^3) on the padded square matrix - fine at the
// stated scale (10-100 drivers, a few hundred guests per batch round).
//
// Rectangular matrices are padded to square with zero-cost dummy rows/cols;
// callers should treat any assignment involving a dummy index as "no match".

export const INFEASIBLE = 1e9;

export function solveHungarian(costMatrix: number[][]): number[] {
  const nRows = costMatrix.length;
  if (nRows === 0) return [];
  const nCols = costMatrix[0].length;
  const n = Math.max(nRows, nCols);

  // Pad to an n x n square matrix.
  const cost: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      i < nRows && j < nCols ? costMatrix[i][j] : 0
    )
  );

  // Standard O(n^3) Jonker-Volgenant-style Hungarian implementation using
  // potentials (u, v) and augmenting paths, 1-indexed internally.
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0); // p[j] = row assigned to column j
  const way = new Array(n + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(Infinity);
    const used = new Array(n + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = -1;
      for (let j = 1; j <= n; j++) {
        if (!used[j]) {
          const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) {
            minv[j] = cur;
            way[j] = j0;
          }
          if (minv[j] < delta) {
            delta = minv[j];
            j1 = j;
          }
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  // rowAssignment[i] = column assigned to row i (0-indexed), or -1 if padded/dummy.
  const rowAssignment = new Array(n).fill(-1);
  for (let j = 1; j <= n; j++) {
    if (p[j] > 0) rowAssignment[p[j] - 1] = j - 1;
  }
  return rowAssignment.slice(0, nRows).map((col) => (col < nCols ? col : -1));
}
