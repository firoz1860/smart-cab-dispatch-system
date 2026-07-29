-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Trip" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "pickupLabel" TEXT NOT NULL,
    "pickupLat" REAL NOT NULL,
    "pickupLng" REAL NOT NULL,
    "dropLabel" TEXT NOT NULL,
    "dropLat" REAL NOT NULL,
    "dropLng" REAL NOT NULL,
    "scheduledTime" DATETIME,
    "deadline" DATETIME,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" DATETIME,
    "assignedAt" DATETIME,
    "pickedUpAt" DATETIME,
    "completedAt" DATETIME,
    "currentStopArrivedAt" DATETIME,
    "totalHaltSeconds" INTEGER NOT NULL DEFAULT 0,
    "totalSeats" INTEGER NOT NULL DEFAULT 0,
    "totalLuggage" INTEGER NOT NULL DEFAULT 0,
    "etaSeconds" INTEGER,
    "priorityScore" REAL NOT NULL DEFAULT 0,
    "rejectedDriverIds" TEXT NOT NULL DEFAULT '',
    "driverId" TEXT,
    "declineReason" TEXT,
    "mergedIntoTripId" TEXT,
    "adminOverride" BOOLEAN NOT NULL DEFAULT false,
    "adminNote" TEXT,
    CONSTRAINT "Trip_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Trip" ("adminNote", "adminOverride", "approvedAt", "assignedAt", "completedAt", "deadline", "declineReason", "driverId", "dropLabel", "dropLat", "dropLng", "etaSeconds", "id", "mergedIntoTripId", "origin", "pickedUpAt", "pickupLabel", "pickupLat", "pickupLng", "priorityScore", "rejectedDriverIds", "requestedAt", "scheduledTime", "status", "totalLuggage", "totalSeats", "type") SELECT "adminNote", "adminOverride", "approvedAt", "assignedAt", "completedAt", "deadline", "declineReason", "driverId", "dropLabel", "dropLat", "dropLng", "etaSeconds", "id", "mergedIntoTripId", "origin", "pickedUpAt", "pickupLabel", "pickupLat", "pickupLng", "priorityScore", "rejectedDriverIds", "requestedAt", "scheduledTime", "status", "totalLuggage", "totalSeats", "type" FROM "Trip";
DROP TABLE "Trip";
ALTER TABLE "new_Trip" RENAME TO "Trip";
CREATE INDEX "Trip_status_idx" ON "Trip"("status");
CREATE INDEX "Trip_driverId_idx" ON "Trip"("driverId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
