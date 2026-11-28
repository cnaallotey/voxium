/**
 * The facts the legal pages need that only the operator of Voxium can give. Until they are filled in, the pages show
 * them as marked placeholders and say that they are drafts. Have a lawyer review the pages before going live.
 */
export const LEGAL = {
  /** Set to true once a lawyer has reviewed the pages and the placeholders below are filled in. */
  reviewed: false,
  company: "[Company legal name]",
  address: "[Registered address]",
  jurisdiction: "[Governing law and courts]",
  contactEmail: "[legal@your-domain]",
  privacyEmail: "[privacy@your-domain]",
  securityEmail: "[security@your-domain]",
  salesEmail: "[sales@your-domain]",
  effectiveDate: "[Effective date]",
  /** How long the operator keeps account and audit data after an account or organization is removed. */
  retention: "[retention period]",
} as const;

/** Whether a value is still a placeholder, shown as "[...]". */
export const isPlaceholder = (value: string) => /^\[.*\]$/.test(value);
