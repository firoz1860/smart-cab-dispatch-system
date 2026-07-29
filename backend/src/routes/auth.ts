import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { signToken, requireAuth } from "../middleware/auth";

export const authRouter = Router();

const loginSchema = z.object({
  phone: z.string().min(3),
  pin: z.string().min(1),
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const user = await prisma.user.findUnique({ where: { phone: parsed.data.phone } });
  if (!user) return res.status(401).json({ error: "Invalid phone or PIN" });

  const ok = await bcrypt.compare(parsed.data.pin, user.pinHash);
  if (!ok) return res.status(401).json({ error: "Invalid phone or PIN" });

  const token = signToken({
    userId: user.id,
    role: user.role as any,
    name: user.name,
    driverId: user.driverId ?? undefined,
    guestId: user.guestId ?? undefined,
  });

  res.json({ token, role: user.role, name: user.name, driverId: user.driverId, guestId: user.guestId });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  res.json(req.auth ?? null);
});
