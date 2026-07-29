import "dotenv/config";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";

// A single fictional 2-day conference in Bengaluru, used throughout the demo.
const PLACES = {
  venue: { name: "Grand Convene Center (Venue)", type: "VENUE", lat: 12.9698, lng: 77.75 },
  airport: { name: "Kempegowda International Airport", type: "AIRPORT", lat: 13.1986, lng: 77.7066 },
  station: { name: "Bengaluru City Railway Station", type: "STATION", lat: 12.9767, lng: 77.5697 },
  accomA: { name: "Lakeside Suites", type: "ACCOMMODATION", lat: 12.9351, lng: 77.6245 },
  accomB: { name: "Hilltop Residency", type: "ACCOMMODATION", lat: 12.9716, lng: 77.5946 },
  accomC: { name: "Airport View Hotel", type: "ACCOMMODATION", lat: 13.1721, lng: 77.6953 },
} as const;

const DRIVER_VEHICLE_PROFILES = [
  { seatCapacity: 4, luggageCapacity: 2, tag: "Sedan" },
  { seatCapacity: 6, luggageCapacity: 4, tag: "SUV" },
  { seatCapacity: 10, luggageCapacity: 6, tag: "Van" },
];

const FIRST_NAMES = [
  "Arjun", "Priya", "Rahul", "Sneha", "Vikram", "Anita", "Karan", "Divya", "Rohan", "Meera",
  "Sanjay", "Pooja", "Aditya", "Neha", "Manoj", "Kavya",
];
const LAST_NAMES = ["Sharma", "Verma", "Iyer", "Nair", "Reddy", "Gupta", "Menon", "Rao"];

// Maps i -> a (first, last) pair via a multiplicative bijection over the full
// 16*8=128-combination space (41 is coprime to 128, so i*41 mod 128 visits
// every combination exactly once before repeating). This avoids the original
// bug (both indices keyed off `i % length` directly repeated every
// LCM(16, 8) = 16 records) without falling back to long same-surname runs -
// the phone number is still each record's real unique identifier, but demo
// data shouldn't make distinct people look like duplicates by sharing a
// display name too.
const TOTAL_NAME_COMBOS = FIRST_NAMES.length * LAST_NAMES.length;
function name(i: number): string {
  const shuffled = (i * 41) % TOTAL_NAME_COMBOS;
  const first = FIRST_NAMES[shuffled % FIRST_NAMES.length];
  const last = LAST_NAMES[Math.floor(shuffled / FIRST_NAMES.length) % LAST_NAMES.length];
  return `${first} ${last}`;
}

function jitterLatLng(lat: number, lng: number, spreadKm = 2): { lat: number; lng: number } {
  const spreadDeg = spreadKm / 111; // ~111km per degree latitude
  return { lat: lat + (Math.random() - 0.5) * spreadDeg, lng: lng + (Math.random() - 0.5) * spreadDeg };
}

async function main() {
  console.log("Clearing existing data...");
  await prisma.tripGuest.deleteMany();
  await prisma.trip.deleteMany();
  await prisma.user.deleteMany();
  await prisma.guest.deleteMany();
  await prisma.driver.deleteMany();
  await prisma.place.deleteMany();
  await prisma.event.deleteMany();

  const now = new Date();
  const event = await prisma.event.create({
    data: {
      name: "Northwind Partners Offsite 2026",
      startDate: now,
      endDate: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000),
      breakSecondsAfterTrip: 600,
      maxDetourSeconds: 480,
    },
  });

  const places: Record<string, Awaited<ReturnType<typeof prisma.place.create>>> = {};
  for (const [key, p] of Object.entries(PLACES)) {
    places[key] = await prisma.place.create({ data: p });
  }
  const accommodations = [places.accomA, places.accomB, places.accomC];

  const pinHash = await bcrypt.hash("1234", 10);
  const adminPinHash = await bcrypt.hash("admin123", 10);

  await prisma.user.create({
    data: { role: "ADMIN", phone: "9000000001", name: "Ops Admin", pinHash: adminPinHash },
  });

  console.log("Creating drivers...");
  const driverCreds: { phone: string; name: string }[] = [];
  const drivers = [];
  for (let i = 0; i < 15; i++) {
    const profile = DRIVER_VEHICLE_PROFILES[i % DRIVER_VEHICLE_PROFILES.length];
    const phone = `90100000${String(i).padStart(2, "0")}`;
    const pos = jitterLatLng(places.venue.lat, places.venue.lng, 8);
    const driver = await prisma.driver.create({
      data: {
        name: name(i),
        phone,
        vehicleNumber: `KA-01-${profile.tag.slice(0, 2).toUpperCase()}-${1000 + i}`,
        seatCapacity: profile.seatCapacity,
        luggageCapacity: profile.luggageCapacity,
        status: "AVAILABLE",
        currentLat: pos.lat,
        currentLng: pos.lng,
      },
    });
    await prisma.user.create({
      data: { role: "DRIVER", phone, name: driver.name, pinHash, driverId: driver.id },
    });
    driverCreds.push({ phone, name: driver.name });
    drivers.push(driver);
  }

  console.log("Creating guests + scheduled arrival trips...");
  const guestCreds: { phone: string; name: string }[] = [];

  for (let i = 0; i < 45; i++) {
    const phone = `92000000${String(i).padStart(3, "0")}`;
    const accommodation = accommodations[i % accommodations.length];
    // Most parties are 1-3 people; a few large ones (>6) to exercise fleet-escalation splitting.
    const partySize = i % 13 === 0 ? 7 : 1 + (i % 4);
    const luggageCount = Math.max(1, Math.round(partySize * 0.8));

    const guest = await prisma.guest.create({
      data: {
        name: name(i + 3),
        phone,
        partySize,
        luggageCount,
        accommodationId: accommodation.id,
      },
    });
    await prisma.user.create({
      data: { role: "GUEST", phone, name: guest.name, pinHash, guestId: guest.id },
    });
    guestCreds.push({ phone, name: guest.name });

    // Cluster arrival times into a handful of "flight batches" so several
    // guests land close together (clustering/shared-ride demo), with a
    // couple of batches already overdue (tests urgency scoring + UNASSIGNABLE
    // flagging under peak load).
    const batch = i % 6;
    const batchOffsetMin = [-20, -5, 15, 40, 75, 120][batch];
    const scheduledTime = new Date(now.getTime() + batchOffsetMin * 60 * 1000 + (i % 5) * 60 * 1000);
    const deadline = new Date(scheduledTime.getTime() + 60 * 60 * 1000);
    const fromAirport = i % 3 !== 0;
    const source = fromAirport ? places.airport : places.station;

    await prisma.trip.create({
      data: {
        type: "ARRIVAL",
        origin: "SCHEDULED",
        status: "QUEUED",
        pickupLabel: source.name,
        pickupLat: source.lat,
        pickupLng: source.lng,
        dropLabel: accommodation.name,
        dropLat: accommodation.lat,
        dropLng: accommodation.lng,
        scheduledTime,
        deadline,
        totalSeats: partySize,
        totalLuggage: luggageCount,
        guests: { create: { guestId: guest.id, seats: partySize, luggage: luggageCount } },
      },
    });
  }

  console.log("Creating a few pending on-demand requests...");
  for (let i = 0; i < 3; i++) {
    const cred = guestCreds[45 - (i + 1)];
    const guest = await prisma.guest.findUnique({ where: { phone: cred.phone } });
    if (!guest) continue;
    const accommodation = accommodations[i % accommodations.length];
    await prisma.trip.create({
      data: {
        type: "ON_DEMAND",
        origin: "ON_DEMAND",
        status: "PENDING_APPROVAL",
        pickupLabel: accommodation.name,
        pickupLat: accommodation.lat,
        pickupLng: accommodation.lng,
        dropLabel: places.venue.name,
        dropLat: places.venue.lat,
        dropLng: places.venue.lng,
        totalSeats: guest.partySize,
        totalLuggage: guest.luggageCount,
        guests: { create: { guestId: guest.id, seats: guest.partySize, luggage: guest.luggageCount } },
      },
    });
  }

  console.log("\n=== Seed complete ===");
  console.log(`Event: ${event.name}`);
  console.log("\nAdmin login -> phone: 9000000001  pin: admin123");
  console.log("\nSample driver logins (pin: 1234):");
  driverCreds.slice(0, 3).forEach((d) => console.log(`  ${d.name} -> phone: ${d.phone}`));
  console.log("\nSample guest logins (pin: 1234):");
  guestCreds.slice(0, 3).forEach((g) => console.log(`  ${g.name} -> phone: ${g.phone}`));
  console.log(`\n${drivers.length} drivers, ${guestCreds.length} guests seeded.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
