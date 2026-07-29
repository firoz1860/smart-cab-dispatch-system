import { prisma } from "../lib/prisma";

/**
 * Fleet escalation: if a single guest party is larger than any available
 * vehicle's seat (or luggage) capacity, no single driver can ever serve it.
 * Split it into two+ new QUEUED trips, each within the largest available
 * vehicle's capacity, so the matching engine (and clustering) can place them
 * on separate vehicles coordinated to the same pickup/drop/time.
 */
export async function splitOversizedTrips(): Promise<void> {
  const drivers = await prisma.driver.findMany({ where: { status: { not: "OFFLINE" } } });
  if (drivers.length === 0) return;
  const maxSeats = Math.max(...drivers.map((d) => d.seatCapacity));
  const maxLuggage = Math.max(...drivers.map((d) => d.luggageCapacity));

  const oversized = await prisma.trip.findMany({
    where: {
      status: "QUEUED",
      OR: [{ totalSeats: { gt: maxSeats } }, { totalLuggage: { gt: maxLuggage } }],
    },
    include: { guests: true },
  });

  for (const trip of oversized) {
    const groups: { seats: number; luggage: number; guestIds: string[] }[] = [];
    for (const g of trip.guests) {
      let placed = false;
      for (const group of groups) {
        if (group.seats + g.seats <= maxSeats && group.luggage + g.luggage <= maxLuggage) {
          group.seats += g.seats;
          group.luggage += g.luggage;
          group.guestIds.push(g.id);
          placed = true;
          break;
        }
      }
      if (!placed) {
        groups.push({ seats: g.seats, luggage: g.luggage, guestIds: [g.id] });
      }
    }

    if (groups.length <= 1) continue; // a single guest party itself exceeds capacity; nothing more we can do automatically

    await prisma.$transaction(async (tx) => {
      const newTripIds: string[] = [];
      for (const group of groups) {
        const newTrip = await tx.trip.create({
          data: {
            type: trip.type,
            origin: trip.origin,
            status: "QUEUED",
            pickupLabel: trip.pickupLabel,
            pickupLat: trip.pickupLat,
            pickupLng: trip.pickupLng,
            dropLabel: trip.dropLabel,
            dropLat: trip.dropLat,
            dropLng: trip.dropLng,
            scheduledTime: trip.scheduledTime,
            deadline: trip.deadline,
            totalSeats: group.seats,
            totalLuggage: group.luggage,
            adminNote: `Auto-split from oversized party (fleet escalation) - trip ${trip.id}`,
          },
        });
        newTripIds.push(newTrip.id);
        await tx.tripGuest.updateMany({
          where: { tripId: trip.id, guestId: { in: group.guestIds } },
          data: { tripId: newTrip.id },
        });
      }
      await tx.trip.update({
        where: { id: trip.id },
        data: {
          status: "CANCELLED",
          adminNote: `Split across ${newTripIds.length} vehicles: ${newTripIds.join(", ")}`,
        },
      });
    });
  }
}
