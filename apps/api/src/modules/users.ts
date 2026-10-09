import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { hashPassword } from "../lib/password.js";
import { toUserDto } from "./auth.js";
import { normalizePhone } from "./auth.js";
import type { Role } from "@ronmacrae/contracts";

const RoleEnum = z.enum(["admin", "dispatcher", "accountant", "viewer", "rider"]);

const CreateBody = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().optional().or(z.literal("")).default(""),
  phone: z.string().min(7).max(20).optional().or(z.literal("")).default(""),
  password: z.string().min(8).max(128),
  role: RoleEnum,
});

const UpdateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  email: z.string().email().optional().or(z.literal("")).nullable(),
  phone: z.string().min(7).max(20).optional().or(z.literal("")).nullable(),
  role: RoleEnum.optional(),
  active: z.boolean().optional(),
  password: z.string().min(8).max(128).optional(),
});

/** Everyone who belongs to this business: staff with a membership here, plus couriers with a membership here.
 *  Deleted accounts stay in the list so history remains attributable. */
function inBusiness(businessId: string) {
  return {
    OR: [{ staffMemberships: { some: { businessId } } }, { rider: { memberships: { some: { businessId } } } }],
  };
}

export async function userRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.get("/api/users", { preHandler: ctx.requireStaff("admin", "dispatcher") }, async (req) => {
    const users = await ctx.prisma.user.findMany({
      where: { ...inBusiness(req.user!.businessId!), platformRole: null },
      orderBy: { name: "asc" },
      include: { rider: { select: { id: true } } },
    });
    return { users: users.map(toUserDto) };
  });

  app.post("/api/users", { preHandler: ctx.requireStaff("admin") }, async (req) => {
    const body = CreateBody.parse(req.body);
    if (!body.email && !body.phone) throw httpErrors.createError(400, "Email or phone required");
    const user = await ctx.prisma.user.create({
      data: {
        name: body.name,
        email: body.email || null,
        phone: body.phone ? normalizePhone(body.phone) : null,
        passwordHash: hashPassword(body.password),
        role: body.role,
      },
    });
    // Every staff role (everything except rider, which is scoped some other
    // way — see resolveStaffContext in auth.ts) needs an active
    // StaffMembership in the creating admin's own business, or login fails
    // outright with "no active business membership": this used to create
    // the bare User and stop there, silently producing an account nobody
    // could ever sign into.
    if (body.role !== "rider") {
      const businessId = req.user!.businessId;
      if (!businessId) throw httpErrors.createError(400, "No business context to add this user to");
      await ctx.prisma.staffMembership.create({
        data: { userId: user.id, businessId, role: body.role, active: true },
      });
    }
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "user.create", "user", user.id, { name: body.name, role: body.role });
    return { user: toUserDto(user) };
  });

  app.patch<{ Params: { id: string } }>("/api/users/:id", { preHandler: ctx.requireStaff("admin") }, async (req) => {
    const body = UpdateBody.parse(req.body);
    const businessId = req.user!.businessId!;
    // Only people who belong to the caller's own business. Anyone else (another
    // company's staff, the platform owner) is "not found", never "forbidden",
    // so this can't be used to probe which accounts exist.
    const target = await ctx.prisma.user.findFirst({ where: { id: req.params.id, platformRole: null, ...inBusiness(businessId) } });
    if (!target) throw httpErrors.createError(404, "User not found");
    // A person who also works with other businesses (or has a merchant / fleet
    // login) is not this business's to re-credential or disable: changing their
    // password, email, phone, role or active flag would hand over — or cut off —
    // access they hold elsewhere. Name edits stay allowed.
    const touchesAccess = body.email !== undefined || body.phone !== undefined || body.role !== undefined || body.active !== undefined || body.password !== undefined;
    if (touchesAccess) {
      const [otherStaff, otherRider, merchantLogins, fleetLogins] = await Promise.all([
        ctx.prisma.staffMembership.count({ where: { userId: target.id, businessId: { not: businessId } } }),
        ctx.prisma.riderMembership.count({ where: { rider: { userId: target.id }, businessId: { not: businessId } } }),
        ctx.prisma.merchantStaff.count({ where: { userId: target.id } }),
        ctx.prisma.logisticsCompanyStaff.count({ where: { userId: target.id } }),
      ]);
      if (otherStaff + otherRider + merchantLogins + fleetLogins > 0) {
        throw httpErrors.createError(409, "This person also works with other businesses, so their sign-in details can only be changed by them or by the platform owner.");
      }
    }
    const user = await ctx.prisma.user.update({
      where: { id: target.id },
      data: {
        name: body.name,
        email: body.email === null ? null : body.email || null,
        phone: body.phone === null ? null : body.phone ? normalizePhone(body.phone) : null,
        role: body.role as Role | undefined,
        active: body.active,
        passwordHash: body.password ? hashPassword(body.password) : undefined,
      },
    });
    if (body.role && body.role !== "rider") {
      // The membership row is what the business actually authorises against.
      await ctx.prisma.staffMembership.updateMany({ where: { userId: target.id, businessId }, data: { role: body.role } });
    }
    if (body.active === false || body.password) {
      await ctx.prisma.session.deleteMany({ where: { userId: target.id } });
    }
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "user.update", "user", target.id, { changes: Object.keys(body) });
    return { user: toUserDto(user) };
  });
}
