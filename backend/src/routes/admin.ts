import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole } from "../middleware/auth";
import { PLACE_TYPES, TRIP_TYPES } from "../lib/constants";
import { runDispatchTick, runBatchAssignment } from "../engine/matchingEngine";
import { adminOverrideAssign, TripActionError } from "../engine/tripActions";
import { getNextStop } from "../engine/stops";

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole("ADMIN"));

// ---- Overview -------------------------------------------------------------

adminRouter.get("/overview", async (_req, res) => {
  const [drivers, trips, event] = await Promise.all([
    prisma.driver.findMany({ orderBy: { name: "asc" } }),
    prisma.trip.findMany({
      where: { status: { not: "CANCELLED" } },
      include: { guests: { include: { guest: true } }, driver: true },
      orderBy: { requestedAt: "desc" },
      take: 300,
    }),
    prisma.event.findFirst(),
  ]);
  res.json({ drivers, trips, event });
});

// ---- Drivers ----------------------------------------------------------------

const driverSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(3),
  pin: z.string().min(4),
  vehicleNumber: z.string().min(1),
  seatCapacity: z.number().int().positive(),
  luggageCapacity: z.number().int().nonnegative(),
  currentLat: z.number(),
  currentLng: z.number(),
});

adminRouter.get("/drivers", async (_req, res) => {
  res.json(await prisma.driver.findMany({ orderBy: { name: "asc" } }));
});

adminRouter.post("/drivers", async (req, res) => {
  const parsed = driverSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;

  const existing = await prisma.user.findUnique({ where: { phone: d.phone } });
  if (existing) return res.status(409).json({ error: "Phone already registered" });

  const pinHash = await bcrypt.hash(d.pin, 10);
  const driver = await prisma.driver.create({
    data: {
      name: d.name,
      phone: d.phone,
      vehicleNumber: d.vehicleNumber,
      seatCapacity: d.seatCapacity,
      luggageCapacity: d.luggageCapacity,
      currentLat: d.currentLat,
      currentLng: d.currentLng,
      status: "OFFLINE",
    },
  });
  await prisma.user.create({
    data: { role: "DRIVER", phone: d.phone, name: d.name, pinHash, driverId: driver.id },
  });
  res.status(201).json(driver);
});

adminRouter.patch("/drivers/:id", async (req, res) => {
  const schema = z.object({
    status: z.enum(["OFFLINE", "AVAILABLE"]).optional(),
    seatCapacity: z.number().int().positive().optional(),
    luggageCapacity: z.number().int().nonnegative().optional(),
    vehicleNumber: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const driver = await prisma.driver.update({ where: { id: req.params.id }, data: parsed.data });
  res.json(driver);
});

// ---- Places -----------------------------------------------------------------

adminRouter.get("/places", async (_req, res) => {
  res.json(await prisma.place.findMany());
});

adminRouter.post("/places", async (req, res) => {
  const schema = z.object({
    name: z.string().min(1),
    type: z.enum(PLACE_TYPES),
    lat: z.number(),
    lng: z.number(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.status(201).json(await prisma.place.create({ data: parsed.data }));
});

// ---- Guests -----------------------------------------------------------------

const guestSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(3),
  pin: z.string().min(4),
  partySize: z.number().int().positive().default(1),
  luggageCount: z.number().int().nonnegative().default(1),
  accommodationId: z.string().optional(),
});

adminRouter.get("/guests", async (_req, res) => {
  res.json(await prisma.guest.findMany({ include: { accommodation: true }, orderBy: { name: "asc" } }));
});

adminRouter.post("/guests", async (req, res) => {
  const parsed = guestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const g = parsed.data;

  const existing = await prisma.user.findUnique({ where: { phone: g.phone } });
  if (existing) return res.status(409).json({ error: "Phone already registered" });

  const pinHash = await bcrypt.hash(g.pin, 10);
  const guest = await prisma.guest.create({
    data: {
      name: g.name,
      phone: g.phone,
      partySize: g.partySize,
      luggageCount: g.luggageCount,
      accommodationId: g.accommodationId,
    },
  });
  await prisma.user.create({
    data: { role: "GUEST", phone: g.phone, name: g.name, pinHash, guestId: guest.id },
  });
  res.status(201).json(guest);
});

adminRouter.patch("/guests/:id", async (req, res) => {
  const schema = z.object({
    partySize: z.number().int().positive().optional(),
    luggageCount: z.number().int().nonnegative().optional(),
    accommodationId: z.string().nullable().optional(),
    notes: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json(await prisma.guest.update({ where: { id: req.params.id }, data: parsed.data }));
});

// ---- Scheduled trips (pre-day known arrivals/departures etc.) --------------

const tripSchema = z.object({
  guestId: z.string(),
  type: z.enum(TRIP_TYPES),
  pickupLabel: z.string(),
  pickupLat: z.number(),
  pickupLng: z.number(),
  dropLabel: z.string(),
  dropLat: z.number(),
  dropLng: z.number(),
  scheduledTime: z.string().datetime().optional(),
  deadline: z.string().datetime().optional(),
});

adminRouter.post("/trips", async (req, res) => {
  const parsed = tripSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const t = parsed.data;
  const guest = await prisma.guest.findUnique({ where: { id: t.guestId } });
  if (!guest) return res.status(404).json({ error: "Guest not found" });

  const trip = await prisma.trip.create({
    data: {
      type: t.type,
      origin: "SCHEDULED",
      status: "QUEUED",
      pickupLabel: t.pickupLabel,
      pickupLat: t.pickupLat,
      pickupLng: t.pickupLng,
      dropLabel: t.dropLabel,
      dropLat: t.dropLat,
      dropLng: t.dropLng,
      scheduledTime: t.scheduledTime ? new Date(t.scheduledTime) : null,
      deadline: t.deadline ? new Date(t.deadline) : null,
      totalSeats: guest.partySize,
      totalLuggage: guest.luggageCount,
      guests: { create: { guestId: guest.id, seats: guest.partySize, luggage: guest.luggageCount } },
    },
  });
  void runDispatchTick();
  res.status(201).json(trip);
});

// ---- On-demand ride requests: approve / decline ----------------------------

adminRouter.get("/requests", async (_req, res) => {
  res.json(
    await prisma.trip.findMany({
      where: { status: "PENDING_APPROVAL" },
      include: { guests: { include: { guest: true } } },
      orderBy: { requestedAt: "asc" },
    })
  );
});

adminRouter.post("/requests/:tripId/approve", async (req, res) => {
  const trip = await prisma.trip.findUnique({ where: { id: req.params.tripId } });
  if (!trip || trip.status !== "PENDING_APPROVAL") {
    return res.status(400).json({ error: "Trip is not a pending request" });
  }
  const updated = await prisma.trip.update({
    where: { id: trip.id },
    data: { status: "QUEUED", approvedAt: new Date() },
  });
  void runDispatchTick();
  res.json(updated);
});

adminRouter.post("/requests/:tripId/decline", async (req, res) => {
  const schema = z.object({ reason: z.string().optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const trip = await prisma.trip.findUnique({ where: { id: req.params.tripId } });
  if (!trip || trip.status !== "PENDING_APPROVAL") {
    return res.status(400).json({ error: "Trip is not a pending request" });
  }
  const updated = await prisma.trip.update({
    where: { id: trip.id },
    data: { status: "DECLINED", declineReason: parsed.data.reason },
  });
  res.json(updated);
});

// ---- Manual override / dispatch controls -----------------------------------

adminRouter.post("/trips/:tripId/override", async (req, res) => {
  const schema = z.object({ driverId: z.string(), note: z.string().optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    await adminOverrideAssign(req.params.tripId, parsed.data.driverId, parsed.data.note);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof TripActionError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

adminRouter.get("/trips/:tripId/stops", async (req, res) => {
  const trip = await prisma.trip.findUnique({ where: { id: req.params.tripId }, include: { guests: true } });
  if (!trip) return res.status(404).json({ error: "Trip not found" });
  res.json({ next: getNextStop(trip, trip.guests) });
});

adminRouter.post("/dispatch/run-batch", async (_req, res) => {
  const result = await runBatchAssignment();
  res.json(result);
});

adminRouter.post("/dispatch/tick", async (_req, res) => {
  await runDispatchTick();
  res.json({ ok: true });
});

// ---- Event config -----------------------------------------------------------

adminRouter.get("/event", async (_req, res) => {
  res.json(await prisma.event.findFirst());
});

adminRouter.patch("/event", async (req, res) => {
  const schema = z.object({
    name: z.string().optional(),
    breakSecondsAfterTrip: z.number().int().positive().optional(),
    maxDetourSeconds: z.number().int().positive().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const event = await prisma.event.findFirst();
  if (!event) return res.status(404).json({ error: "No event configured" });
  res.json(await prisma.event.update({ where: { id: event.id }, data: parsed.data }));
});
