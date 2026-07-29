import { prisma } from "../lib/prisma";
import { haversineMeters, centroid } from "../lib/geo";
import { ENGINE_CONFIG } from "./config";

/** A queued trip together with the resolved data needed to decide clustering. */
type QueuedTripWithGuests = Awaited<ReturnType<typeof fetchQueuedTrips>>[number];

async function fetchQueuedTrips(eventDrivers: { seatCapacity: number; luggageCapacity: number }[]) {
  return prisma.trip.findMany({
    where: { status: "QUEUED" },
    include: { guests: true },
    orderBy: [{ scheduledTime: "asc" }, { requestedAt: "asc" }],
  });
}

function timeKey(t: { scheduledTime: Date | null; requestedAt: Date }): number {
  return (t.scheduledTime ?? t.requestedAt).getTime();
}

function groupKey(t: QueuedTripWithGuests): string {
  const roundedLat = Math.round(t.dropLat * 1000) / 1000;
  const roundedLng = Math.round(t.dropLng * 1000) / 1000;
  return `${t.type}|${roundedLat}|${roundedLng}`;
}

interface Cluster {
  trips: QueuedTripWithGuests[];
  seats: number;
  luggage: number;
  pickupCentroid: { lat: number; lng: number };
}

/**
 * Greedily bin-packs same-destination QUEUED trips (within a pickup-proximity
 * and time-window tolerance) into shared-ride clusters, subject to the largest
 * available vehicle's capacity. Persists merges: the earliest trip in each
 * cluster survives as the ride record, the rest are marked CANCELLED with
 * mergedIntoTripId pointing at the survivor, and their guests are re-pointed
 * (with a stop-location override, since their real pickup/drop may differ from
 * the surviving trip's primary pickup/drop).
 *
 * Returns the ids of trips that are still QUEUED and ready for assignment
 * (survivors of merges + any trip that didn't cluster with anything).
 */
export async function clusterQueuedTrips(): Promise<string[]> {
  const drivers = await prisma.driver.findMany({ where: { status: { not: "OFFLINE" } } });
  if (drivers.length === 0) return (await prisma.trip.findMany({ where: { status: "QUEUED" } })).map((t) => t.id);

  const maxSeats = Math.max(...drivers.map((d) => d.seatCapacity));
  const maxLuggage = Math.max(...drivers.map((d) => d.luggageCapacity));

  const queued = await fetchQueuedTrips(drivers);
  const groups = new Map<string, QueuedTripWithGuests[]>();
  for (const t of queued) {
    const key = groupKey(t);
    const arr = groups.get(key) ?? [];
    arr.push(t);
    groups.set(key, arr);
  }

  const survivorIds: string[] = [];
  const windowMs = ENGINE_CONFIG.CLUSTER_TIME_WINDOW_MIN * 60 * 1000;

  for (const trips of groups.values()) {
    const clusters: Cluster[] = [];

    for (const trip of trips) {
      const pickup = { lat: trip.pickupLat, lng: trip.pickupLng };
      let placed = false;

      for (const cluster of clusters) {
        const fitsSeats = cluster.seats + trip.totalSeats <= maxSeats;
        const fitsLuggage = cluster.luggage + trip.totalLuggage <= maxLuggage;
        const withinSpread =
          haversineMeters(cluster.pickupCentroid, pickup) <=
          ENGINE_CONFIG.CLUSTER_MAX_PICKUP_SPREAD_M;
        const anchorTime = timeKey(cluster.trips[0]);
        const withinWindow = Math.abs(timeKey(trip) - anchorTime) <= windowMs;

        if (fitsSeats && fitsLuggage && withinSpread && withinWindow) {
          cluster.trips.push(trip);
          cluster.seats += trip.totalSeats;
          cluster.luggage += trip.totalLuggage;
          cluster.pickupCentroid = centroid(cluster.trips.map((t) => ({ lat: t.pickupLat, lng: t.pickupLng })));
          placed = true;
          break;
        }
      }

      if (!placed) {
        clusters.push({
          trips: [trip],
          seats: trip.totalSeats,
          luggage: trip.totalLuggage,
          pickupCentroid: pickup,
        });
      }
    }

    for (const cluster of clusters) {
      if (cluster.trips.length === 1) {
        survivorIds.push(cluster.trips[0].id);
        continue;
      }

      const survivor = cluster.trips[0];
      const others = cluster.trips.slice(1);
      const allPickupsSame = cluster.trips.every(
        (t) => t.pickupLabel === survivor.pickupLabel
      );

      await prisma.$transaction(async (tx) => {
        // Give the survivor's own guests an explicit stop override equal to
        // their original pickup/drop, since the parent Trip's pickup/drop is
        // about to become a merged centroid/label.
        for (const tg of survivor.guests) {
          await tx.tripGuest.update({
            where: { id: tg.id },
            data: {
              stopPickupLabel: survivor.pickupLabel,
              stopPickupLat: survivor.pickupLat,
              stopPickupLng: survivor.pickupLng,
              stopDropLabel: survivor.dropLabel,
              stopDropLat: survivor.dropLat,
              stopDropLng: survivor.dropLng,
              stopOrder: 0,
            },
          });
        }

        let order = 1;
        for (const other of others) {
          for (const tg of other.guests) {
            await tx.tripGuest.update({
              where: { id: tg.id },
              data: {
                tripId: survivor.id,
                stopPickupLabel: other.pickupLabel,
                stopPickupLat: other.pickupLat,
                stopPickupLng: other.pickupLng,
                stopDropLabel: other.dropLabel,
                stopDropLat: other.dropLat,
                stopDropLng: other.dropLng,
                stopOrder: order,
              },
            });
          }
          order += 1;
          await tx.trip.update({
            where: { id: other.id },
            data: { status: "CANCELLED", mergedIntoTripId: survivor.id },
          });
        }

        const earliestDeadline = cluster.trips
          .map((t) => t.deadline)
          .filter((d): d is Date => d != null)
          .sort((a, b) => a.getTime() - b.getTime())[0];

        await tx.trip.update({
          where: { id: survivor.id },
          data: {
            pickupLabel: allPickupsSame ? survivor.pickupLabel : `Multiple pickups (${cluster.trips.length})`,
            pickupLat: cluster.pickupCentroid.lat,
            pickupLng: cluster.pickupCentroid.lng,
            totalSeats: cluster.seats,
            totalLuggage: cluster.luggage,
            deadline: earliestDeadline ?? survivor.deadline,
          },
        });
      });

      survivorIds.push(survivor.id);
    }
  }

  return survivorIds;
}
