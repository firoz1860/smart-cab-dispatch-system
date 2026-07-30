-- CreateIndex
CREATE INDEX "TripGuest_guestId_idx" ON "TripGuest"("guestId");

-- CreateIndex
CREATE UNIQUE INDEX "TripGuest_stripePaymentIntentId_key" ON "TripGuest"("stripePaymentIntentId");
