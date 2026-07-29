export interface Place {
  id: string;
  name: string;
  type: string;
  lat: number;
  lng: number;
}

export interface Driver {
  id: string;
  name: string;
  vehicleNumber: string;
  currentLat: number;
  currentLng: number;
}

export interface Trip {
  id: string;
  type: string;
  status: string;
  pickupLabel: string;
  pickupLat: number;
  pickupLng: number;
  dropLabel: string;
  dropLat: number;
  dropLng: number;
  scheduledTime: string | null;
  requestedAt: string;
  etaSeconds: number | null;
  driver?: Driver | null;
  myStopOrder?: number;
  myBoarded?: boolean;
  myDroppedOff?: boolean;
}

export interface Guest {
  id: string;
  name: string;
  phone: string;
  partySize: number;
  luggageCount: number;
  accommodation: Place | null;
}
