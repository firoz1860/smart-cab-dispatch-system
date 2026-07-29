import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole } from "../middleware/auth";
import { acceptTrip, rejectTrip, advanceTripStop, TripActionError } from "../engine/tripActions";
import { getNextStop, allStopsForDisplay } from "../engine/stops";
import { runDispatchTick } from "../engine/matchingEngine";

export const driverRouter = Router();
driverRouter.use(requireAuth, requireRole("DRIVER"));

function driverId(req: import("express").Request): string {
  return req.auth!.driverId!;
}

driverRouter.get("/me", async (req, res) => {
  const driver = await prisma.driver.findUnique({ where: { id: driverId(req) } });
  res.json(driver);
});

driverRouter.post("/status", async (req, res) => {
  const schema = z.object({ status: z.enum(["AVAILABLE", "OFFLINE"]) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const driver = await prisma.driver.update({
    where: { id: driverId(req) },
    data: { status: parsed.data.status },
  });
  if (parsed.data.status === "AVAILABLE") void runDispatchTick();
  res.json(driver);
});

driverRouter.post("/location", async (req, res) => {
  const schema = z.object({ lat: z.number(), lng: z.number() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  await prisma.driver.update({
    where: { id: driverId(req) },
    data: { currentLat: parsed.data.lat, currentLng: parsed.data.lng, lastUpdatedAt: new Date() },
  });
  res.json({ ok: true });
});

/** The driver's single active trip (never the full queue/dashboard - that's
 * Admin/Operations-only), with the next actionable stop and full stop list
 * for display. */
driverRouter.get("/trip", async (req, res) => {
  const trip = await prisma.trip.findFirst({
    where: {
      driverId: driverId(req),
      status: { in: ["ASSIGNED", "EN_ROUTE_PICKUP", "ARRIVED_PICKUP", "IN_PROGRESS"] },
    },
    include: { guests: { include: { guest: true } } },
    orderBy: { assignedAt: "desc" },
  });
  if (!trip) return res.json(null);
  res.json({ trip, nextStop: getNextStop(trip, trip.guests), stops: allStopsForDisplay(trip, trip.guests) });
});

driverRouter.post("/trip/:id/accept", async (req, res) => {
  try {
    await acceptTrip(req.params.id, driverId(req));
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof TripActionError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

driverRouter.post("/trip/:id/reject", async (req, res) => {
  try {
    await rejectTrip(req.params.id, driverId(req));
    void runDispatchTick();
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof TripActionError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

driverRouter.post("/trip/:id/advance", async (req, res) => {
  try {
    await advanceTripStop(req.params.id, driverId(req));
    void runDispatchTick();
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof TripActionError) return res.status(400).json({ error: err.message });
    throw err;
  }
});
