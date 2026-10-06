import { z } from "zod";
import { categories, decodeCursor } from "@crime-radar/shared";
const number = z.coerce.number().finite();
export const querySchema = z
  .object({
    north: number.min(-85).max(85),
    south: number.min(-85).max(85),
    east: number.min(-180).max(180),
    west: number.min(-180).max(180),
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    dateBasis: z.enum(["event", "publication"]).optional(),
    categories: z
      .string()
      .max(200)
      .optional()
      .transform((value) => (value ? value.split(",") : []))
      .pipe(z.array(z.enum(categories)).max(9)),
    query: z
      .string()
      .max(200)
      .refine(
        (value) => value.trim().split(/\s+/).filter(Boolean).length <= 32,
        "Too many search terms",
      )
      .optional(),
    limit: z.coerce.number().int().min(1).max(2000).default(500),
    cursor: z
      .string()
      .max(512)
      .regex(/^[\w-]+$/)
      .refine((value) => {
        try {
          decodeCursor(value);
          return true;
        } catch {
          return false;
        }
      }, "Invalid cursor")
      .optional(),
  })
  .refine(
    (q) => {
      if (!q.cursor) return true;
      try {
        return decodeCursor(q.cursor).dateBasis === q.dateBasis;
      } catch {
        return false;
      }
    },
    {
      message: "Cursor date basis does not match query",
    },
  )
  .refine((q) => q.north > q.south, { message: "north must be above south" })
  .refine((q) => q.west <= q.east, {
    message: "This API requires a non-crossing bounding box",
  })
  .refine((q) => Date.parse(q.from) <= Date.parse(q.to), {
    message: "Invalid date interval",
  })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= 366 * 86400000, {
    message: "Maximum interval is 366 days",
  });
