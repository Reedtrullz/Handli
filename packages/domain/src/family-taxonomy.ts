import { z } from "zod";

import { canonicalTimestampSchema, contractVersionSchema, hasUniqueStrings } from "./contract-primitives";

const taxonomyIdentifierShape = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const familyIdentifierShape = /^family:[a-z0-9]+(?:-[a-z0-9]+)*$/;
const taxonomyVersionShape = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const norwegianAliasShape = /^[a-z0-9æøå]+(?:[ -][a-z0-9æøå]+)*$/;
const sha256Shape = /^[0-9a-f]{64}$/;

export const familyTaxonomyIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(taxonomyIdentifierShape);

export const familyTaxonomyVersionSchema = z
  .string()
  .min(5)
  .max(32)
  .regex(taxonomyVersionShape);

export const familyIdentifierSchema = z
  .string()
  .min(8)
  .max(80)
  .regex(familyIdentifierShape);

export const familySlugSchema = z.string().min(1).max(80).regex(taxonomyIdentifierShape);

export const familyAliasSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(norwegianAliasShape)
  .refine((alias) => alias.normalize("NFC") === alias, {
    message: "Family aliases must use Unicode NFC normalization",
  });

export const reviewedFamilyDescriptorSchema = z
  .object({
    id: familyIdentifierSchema,
    slug: familySlugSchema,
    labelNo: z.string().trim().min(1).max(160),
    aliases: z.array(familyAliasSchema).max(20),
    parentId: familyIdentifierSchema.optional(),
    status: z.enum(["active", "retired"]),
  })
  .strict()
  .refine(({ aliases }) => hasUniqueStrings(aliases), {
    message: "Aliases for a family must be unique",
    path: ["aliases"],
  });

export type ReviewedFamilyDescriptor = z.infer<typeof reviewedFamilyDescriptorSchema>;

function addTaxonomyGraphIssues(
  families: readonly ReviewedFamilyDescriptor[],
  context: z.RefinementCtx,
): void {
  const familyIds = families.map(({ id }) => id);
  if (!hasUniqueStrings(familyIds)) {
    context.addIssue({
      code: "custom",
      message: "Family IDs must be unique within a taxonomy version",
      path: ["families"],
    });
  }

  const slugs = families.map(({ slug }) => slug);
  if (!hasUniqueStrings(slugs)) {
    context.addIssue({
      code: "custom",
      message: "Family slugs must be unique within a taxonomy version",
      path: ["families"],
    });
  }

  const aliases = families.flatMap(({ aliases: familyAliases }) => familyAliases);
  if (!hasUniqueStrings(aliases)) {
    context.addIssue({
      code: "custom",
      message: "Family aliases must be unique across a taxonomy version",
      path: ["families"],
    });
  }

  const lookupKeys = [...slugs, ...aliases];
  if (!hasUniqueStrings(lookupKeys)) {
    context.addIssue({
      code: "custom",
      message: "Family aliases must not collide with family slugs",
      path: ["families"],
    });
  }

  const familyById = new Map(families.map((family) => [family.id, family]));
  for (const [index, family] of families.entries()) {
    if (family.parentId !== undefined && !familyById.has(family.parentId)) {
      context.addIssue({
        code: "custom",
        message: `Parent family ${family.parentId} is not defined in this taxonomy version`,
        path: ["families", index, "parentId"],
      });
    }
  }

  const completelyVisited = new Set<string>();
  const visiting = new Set<string>();

  function visit(familyId: string): boolean {
    if (completelyVisited.has(familyId)) return false;
    if (visiting.has(familyId)) return true;

    visiting.add(familyId);
    const parentId = familyById.get(familyId)?.parentId;
    const hasCycle = parentId !== undefined && familyById.has(parentId) && visit(parentId);
    visiting.delete(familyId);
    completelyVisited.add(familyId);
    return hasCycle;
  }

  for (const [index, family] of families.entries()) {
    if (visit(family.id)) {
      context.addIssue({
        code: "custom",
        message: "Family parent references must not contain cycles",
        path: ["families", index, "parentId"],
      });
      break;
    }
  }
}

export const familyTaxonomySchema = z
  .object({
    $schema: z.literal("./product-family-taxonomy.v1.schema.json"),
    contractVersion: contractVersionSchema,
    taxonomyId: familyTaxonomyIdSchema,
    taxonomyVersion: familyTaxonomyVersionSchema,
    versionId: z.string().min(7).max(120),
    publishedAt: canonicalTimestampSchema,
    contentSha256: z.string().regex(sha256Shape),
    families: z.array(reviewedFamilyDescriptorSchema).min(1).max(500),
  })
  .strict()
  .superRefine((taxonomy, context) => {
    if (taxonomy.versionId !== `${taxonomy.taxonomyId}@${taxonomy.taxonomyVersion}`) {
      context.addIssue({
        code: "custom",
        message: "Version ID must bind the taxonomy ID and taxonomy version",
        path: ["versionId"],
      });
    }
    addTaxonomyGraphIssues(taxonomy.families, context);
  });

export type FamilyTaxonomy = z.infer<typeof familyTaxonomySchema>;

export function parseFamilyTaxonomy(input: unknown): FamilyTaxonomy {
  return familyTaxonomySchema.parse(input);
}

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue | undefined };

function canonicalizeJson(value: CanonicalJsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;

  const objectValue = value as { readonly [key: string]: CanonicalJsonValue | undefined };
  const entries = Object.keys(objectValue)
    .filter((key) => objectValue[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(objectValue[key] as CanonicalJsonValue)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Returns the normative checksum input for a taxonomy's family descriptors.
 * Object keys are sorted recursively; array order and Unicode code points are
 * preserved. `contentSha256` is SHA-256 over the UTF-8 bytes of this string.
 */
export function canonicalizeFamilyTaxonomyContent(
  families: readonly (Omit<ReviewedFamilyDescriptor, "aliases"> & {
    readonly aliases: readonly string[];
  })[],
): string {
  return canonicalizeJson(families as readonly CanonicalJsonValue[]);
}
