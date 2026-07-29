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
INSERT INTO "new_Trip" ("approvedAt", "assignedAt", "completedAt", "deadline", "declineReason", "driverId", "dropLabel", "dropLat", "dropLng", "etaSeconds", "id", "origin", "pickedUpAt", "pickupLabel", "pickupLat", "pickupLng", "priorityScore", "rejectedDriverIds", "requestedAt", "scheduledTime", "status", "totalLuggage", "totalSeats", "type") SELECT "approvedAt", "assignedAt", "completedAt", "deadline", "declineReason", "driverId", "dropLabel", "dropLat", "dropLng", "etaSeconds", "id", "origin", "pickedUpAt", "pickupLabel", "pickupLat", "pickupLng", "priorityScore", "rejectedDriverIds", "requestedAt", "scheduledTime", "status", "totalLuggage", "totalSeats", "type" FROM "Trip";
DROP TABLE "Trip";
ALTER TABLE "new_Trip" RENAME TO "Trip";
CREATE INDEX "Trip_status_idx" ON "Trip"("status");
CREATE INDEX "Trip_driverId_idx" ON "Trip"("driverId");
CREATE TABLE "new_TripGuest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tripId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "seats" INTEGER NOT NULL,
    "luggage" INTEGER NOT NULL,
    "boarded" BOOLEAN NOT NULL DEFAULT false,
    "droppedOff" BOOLEAN NOT NULL DEFAULT false,
    "stopOrder" INTEGER NOT NULL DEFAULT 0,
    "stopPickupLabel" TEXT,
    "stopPickupLat" REAL,
    "stopPickupLng" REAL,
    "stopDropLabel" TEXT,
    "stopDropLat" REAL,
    "stopDropLng" REAL,
    CONSTRAINT "TripGuest_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TripGuest_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_TripGuest" ("boarded", "droppedOff", "guestId", "id", "luggage", "seats", "tripId") SELECT "boarded", "droppedOff", "guestId", "id", "luggage", "seats", "tripId" FROM "TripGuest";
DROP TABLE "TripGuest";
ALTER TABLE "new_TripGuest" RENAME TO "TripGuest";
CREATE UNIQUE INDEX "TripGuest_tripId_guestId_key" ON "TripGuest"("tripId", "guestId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
