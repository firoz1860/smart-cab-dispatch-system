import { solveHungarian, INFEASIBLE } from "../engine/hungarian";
import { prisma } from "./prisma";

function assertEqual(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${msg} — expected ${e}, got ${a}`);
  console.log(`PASS: ${msg}`);
}

function totalCost(matrix: number[][], assignment: number[]): number {
  let sum = 0;
  for (let i = 0; i < assignment.length; i++) {
    if (assignment[i] !== -1) sum += matrix[i][assignment[i]];
  }
  return sum;
}

function testHungarianSquare() {
  // 3x3 example. All 6 permutations enumerated by hand:
  //   0-0,1-1,2-2 = 82+37+5  = 124
  //   0-0,1-2,2-1 = 82+49+69 = 200
  //   0-1,1-0,2-2 = 83+77+5  = 165
  //   0-1,1-2,2-0 = 83+49+11 = 143
  //   0-2,1-0,2-1 = 69+77+69 = 215
  //   0-2,1-1,2-0 = 69+37+11 = 117  <- true minimum
  const matrix = [
    [82, 83, 69],
    [77, 37, 49],
    [11, 69, 5],
  ];
  const assignment = solveHungarian(matrix);
  const cost = totalCost(matrix, assignment);
  assertEqual(cost, 117, "3x3 Hungarian optimal cost matches brute-force minimum");
  // Verify it's a valid permutation (no two rows share a column)
  const cols = assignment.filter((c) => c !== -1);
  assertEqual(new Set(cols).size, cols.length, "3x3 Hungarian assignment has no column collisions");
}

function testHungarianRectangularMoreTripsThanDrivers() {
  // 4 trips, 2 drivers -> 2 trips must go unmatched (dummy columns)
  const matrix = [
    [10, 20],
    [15, 5],
    [1000000, 1000000],
    [30, 25],
  ];
  const assignment = solveHungarian(matrix);
  const matchedRows = assignment.filter((c) => c !== -1).length;
  assertEqual(matchedRows, 2, "4 trips x 2 drivers: exactly 2 get matched");
  const cols = assignment.filter((c) => c !== -1);
  assertEqual(new Set(cols).size, cols.length, "no two trips share the same driver");
}

function testHungarianInfeasiblePairsAvoided() {
  // Trip 0 can only go with driver 1 (driver 0 is infeasible/over capacity).
  // Trip 1 can go with either. A correct solver assigns trip0->driver1,
  // trip1->driver0, total cost 5+8=13, rather than picking driver0 for trip0
  // (infeasible) which would blow up the cost.
  const matrix = [
    [INFEASIBLE, 5],
    [8, 9],
  ];
  const assignment = solveHungarian(matrix);
  assertEqual(assignment, [1, 0], "infeasible pair avoided in favor of feasible optimal assignment");
}

async function inspectSeedAssignment() {
  console.log("\n--- Inspecting live DB state after a dispatch tick ---");
  const drivers = await prisma.driver.findMany();
  const trips = await prisma.trip.findMany({ where: { status: { not: "CANCELLED" } } });

  const byStatus: Record<string, number> = {};
  for (const t of trips) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  console.log("Trip status counts:", byStatus);

  const availableDrivers = drivers.filter((d) => d.status === "AVAILABLE");
  const queuedTrips = trips.filter((t) => t.status === "QUEUED");
  console.log(`Available drivers: ${availableDrivers.length}, Queued trips: ${queuedTrips.length}`);

  if (availableDrivers.length > 0 && queuedTrips.length > 0) {
    console.log("\nChecking why queued trips aren't matched to idle drivers (capacity feasibility):");
    for (const t of queuedTrips.slice(0, 15)) {
      const feasibleDrivers = availableDrivers.filter(
        (d) => t.totalSeats <= d.seatCapacity && t.totalLuggage <= d.luggageCapacity
      );
      console.log(
        `  Trip ${t.id.slice(0, 8)} seats=${t.totalSeats} luggage=${t.totalLuggage} -> feasible idle drivers: ${feasibleDrivers.length} (of ${availableDrivers.length})`
      );
    }
    console.log("\nIdle driver capacities:", availableDrivers.map((d) => `${d.seatCapacity}s/${d.luggageCapacity}l`));
  }
}

async function main() {
  testHungarianSquare();
  testHungarianRectangularMoreTripsThanDrivers();
  testHungarianInfeasiblePairsAvoided();
  await inspectSeedAssignment();
  console.log("\nAll Hungarian solver unit tests passed.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
