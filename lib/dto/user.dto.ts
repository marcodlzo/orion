/**
 * Read DTOs for the authenticated user.
 *
 * ALLOWLIST, not blacklist. The mapper names every field it copies, so a new
 * column on the user document cannot reach a client by default. A blacklist
 * ("delete ssn") fails the moment somebody adds a second sensitive field.
 *
 * No secrets live in this module, so it is safe for a client component to
 * import the type.
 */

/**
 * What the UI genuinely needs about the signed-in user.
 *
 * Derived from actual usage, not assumed:
 *   firstName  Footer avatar initial, RightSidebar, HeaderBox greeting,
 *              BankCard userName on /my-banks
 *   lastName   Footer, RightSidebar
 *   email      Footer, RightSidebar
 *   id         stable identifier for the record
 *
 * Deliberately absent — the user document holds all of these and no rendering
 * path reads any of them:
 *   ssn, dateOfBirth, address1, city, state, postalCode,
 *   dwollaCustomerId, dwollaCustomerUrl,
 *   and every $-prefixed Appwrite metadata field
 */
export type CurrentUserDTO = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
};

/** Fields the mapper may emit. Used by tests to prove the shape cannot widen. */
export const CURRENT_USER_DTO_FIELDS = [
  "id",
  "firstName",
  "lastName",
  "email",
] as const;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Map a raw user record to the client-facing DTO.
 *
 * Builds a fresh object literal rather than copying-and-deleting, so nothing
 * can ride along from the source record.
 */
export function toCurrentUserDTO(record: unknown): CurrentUserDTO | null {
  if (!record || typeof record !== "object") return null;
  const r = record as Record<string, unknown>;

  return {
    id: str(r.$id),
    firstName: str(r.firstName),
    lastName: str(r.lastName),
    email: str(r.email),
  };
}
