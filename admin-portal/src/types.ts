export interface Driver {
  id: string;
  name: string;
  phone: string;
  vehicleNumber: string;
  seatCapacity: number;
  luggageCapacity: number;
  status: string;
  currentLat: number;
  currentLng: number;
  freeAt: string | null;
  totalEarningsCents: number;
}

export interface Guest {
  id: string;
  name: string;
  phone: string;
  partySize: number;
  luggageCount: number;
  accommodationId: string | null;
  accommodation?: Place | null;
  notes: string | null;
}

export interface Place {
  id: string;
  name: string;
  type: string;
  lat: number;
  lng: number;
}

export interface TripGuestEntry {
  id: string;
  guestId: string;
  seats: number;
  luggage: number;
  boarded: boolean;
  droppedOff: boolean;
  stopOrder: number;
  guest?: Guest;
}

export interface Trip {
  id: string;
  type: string;
  origin: string;
  status: string;
  pickupLabel: string;
  pickupLat: number;
  pickupLng: number;
  dropLabel: string;
  dropLat: number;
  dropLng: number;
  scheduledTime: string | null;
  deadline: string | null;
  requestedAt: string;
  assignedAt: string | null;
  totalSeats: number;
  totalLuggage: number;
  etaSeconds: number | null;
  driverId: string | null;
  driver?: Driver | null;
  guests: TripGuestEntry[];
  adminOverride: boolean;
  adminNote: string | null;
  declineReason: string | null;

  // Present only on the guest-facing /guest/trips response - this guest's
  // own progress/fare within (possibly shared) trip, not the trip as a whole.
  myStopOrder?: number;
  myBoarded?: boolean;
  myDroppedOff?: boolean;
  myFareAmountCents?: number | null;
  myPaymentStatus?: string;
}

export interface Event {
  id: string;
  name: string;
  breakSecondsAfterTrip: number;
  maxDetourSeconds: number;
}
