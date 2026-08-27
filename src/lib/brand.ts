/**
 * The house palette, shared by everything Yadah prints.
 *
 * Taken from the dashboard design (2026-08-27). Values were read from the
 * design rather than exported from a token file — the frontend lives in a
 * separate repo — so if exact tokens exist, correct them HERE and every PDF
 * follows. Nothing else in the codebase should hardcode a colour.
 *
 * Roles are named for what they do, not what they look like, so a future
 * rebrand is one edit rather than a hunt through layout code.
 */
export const BRAND = {
  /**
   * Primary coral. On screen this carries the main data series and negative
   * amounts; in print it marks the letterhead and anything that needs
   * attention.
   */
  coral: '#E2543C',
  /**
   * Near-black navy. Body text, figures, totals and section headings — the
   * dashboard keeps its card titles this colour rather than the accent, and
   * printed statements read better the same way.
   */
  ink: '#1B2430',
  /** Secondary text: captions, labels, footers. */
  muted: '#6B7280',
  /**
   * Hairline rules. Deliberately a shade darker than the screen's border token:
   * a 1px #E5E7EB line all but vanishes on a photocopy, and these documents get
   * photocopied.
   */
  rule: '#C9CED6',
  /**
   * Tertiary data colour (the dashboard's credit-out series). Too light to
   * carry text or a border in print — reserve it for filled shapes.
   */
  blue: '#8FAFDE',

  // ---- screen-only tints. Email needs fills and page chrome that print does
  // not: paper is already white, so a PDF has no use for a surface colour.
  /** Page background behind the card, as on the dashboard. */
  canvas: '#F7F7F8',
  /** Card and content background. */
  surface: '#FFFFFF',
  /** Coral at low opacity — a highlight fill that keeps dark text readable. */
  coralSoft: '#FDEEEA',
  /** Border for a coralSoft panel. */
  coralBorder: '#F4C4B8',
  /** Fine print: legal lines and disclaimers, a step lighter than muted. */
  mutedLight: '#9AA3AF',
} as const;

/**
 * The logo mark, hosted on Cloudinary. Emails reference it by URL because mail
 * clients cannot read local files; PDFs do not use it — they draw the wordmark
 * as text so the document never depends on a network fetch to look right.
 */
export const BRAND_LOGO_URL =
  'https://res.cloudinary.com/rgodzxvt/image/upload/v1784909266/yadah/brand/logo-symbol.png';
