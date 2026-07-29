-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Driver" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "vehicleNumber" TEXT NOT NULL,
    "seatCapacity" INTEGER NOT NULL,
    "luggageCapacity" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OFFLINE',
    "currentLat" REAL NOT NULL,
    "currentLng" REAL NOT NULL,
    "freeAt" DATETIME,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalEarningsCents" INTEGER NOT NULL DEFAULT 0
);
INSERT INTO "new_Driver" ("createdAt", "currentLat", "currentLng", "freeAt", "id", "lastUpdatedAt", "luggageCapacity", "name", "phone", "seatCapacity", "status", "vehicleNumber") SELECT "createdAt", "currentLat", "currentLng", "freeAt", "id", "lastUpdatedAt", "luggageCapacity", "name", "phone", "seatCapacity", "status", "vehicleNumber" FROM "Driver";
DROP TABLE "Driver";
ALTER TABLE "new_Driver" RENAME TO "Driver";
CREATE UNIQUE INDEX "Driver_phone_key" ON "Driver"("phone");
CREATE INDEX "Driver_status_idx" ON "Driver"("status");
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
    "fareAmountCents" INTEGER,
    "paymentStatus" TEXT NOT NULL DEFAULT 'UNPAID',
    "stripePaymentIntentId" TEXT,
    "paidAt" DATETIME,
    CONSTRAINT "TripGuest_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TripGuest_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_TripGuest" ("boarded", "droppedOff", "guestId", "id", "luggage", "seats", "stopDropLabel", "stopDropLat", "stopDropLng", "stopOrder", "stopPickupLabel", "stopPickupLat", "stopPickupLng", "tripId") SELECT "boarded", "droppedOff", "guestId", "id", "luggage", "seats", "stopDropLabel", "stopDropLat", "stopDropLng", "stopOrder", "stopPickupLabel", "stopPickupLat", "stopPickupLng", "tripId" FROM "TripGuest";
DROP TABLE "TripGuest";
ALTER TABLE "new_TripGuest" RENAME TO "TripGuest";
CREATE UNIQUE INDEX "TripGuest_tripId_guestId_key" ON "TripGuest"("tripId", "guestId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
