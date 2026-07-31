/**
 * Repository-identity normalisation (`docs/DOMAIN_MODEL.md` section 6).
 *
 * A repository is named several ways by the same people on the same day:
 * `git@github.com:example/refresh-surplus.git`,
 * `https://github.com/example/refresh-surplus.git`, and the bare
 * `github.com/example/refresh-surplus` a human types. They are one repository,
 * and the domain model says so: identity is the **provider-agnostic canonical
 * form**, with the clone URLs recorded beside it.
 *
 * It lives in `packages/protocol` rather than in the control plane because the
 * canonical form is a stored, compared and audited value: the connector matches
 * a checkout against it, the web application previews it while an operator
 * types, and `project.repository_changed` records both sides of a move. Three
 * implementations of "the same repository" would eventually disagree, and the
 * disagreement would look like a project that has quietly forgotten its code.
 *
 * Normalisation is deliberately lossy in one direction only: it removes a
 * scheme, a `userinfo` component, a default port, a `.git` suffix and trailing
 * slashes, and it lowercases the host. It never rewrites a path's case, because
 * on most forges the path is case-sensitive and two projects may differ by it.
 *
 * A `userinfo` component is dropped rather than preserved, and never stored:
 * `https://someone:token@example.com/repo.git` is a credential in a URL, and
 * `docs/SECURITY.md` section 18 does not stop applying because a caller pasted
 * it into a form.
 */

/** The canonical form plus the clone URLs that reduce to it. */
export interface NormalisedRepositoryIdentity {
  readonly canonical: string;
  readonly clone_urls: readonly string[];
}

/** What an operator may supply: one URL, or a record with several. */
export type RepositoryIdentityInput =
  | string
  | {
      readonly canonical?: string | undefined;
      readonly clone_urls?: readonly string[] | undefined;
    };

/** Why a value could not be normalised. Stable, so a caller can branch on it. */
export type RepositoryIdentityFailure =
  | "empty"
  | "too_long"
  | "invalid_characters"
  | "unsupported_scheme"
  | "missing_host"
  | "missing_path"
  | "inconsistent_urls"
  | "too_many_clone_urls";

export type RepositoryIdentityResult =
  | { readonly ok: true; readonly value: NormalisedRepositoryIdentity }
  | { readonly ok: false; readonly reason: RepositoryIdentityFailure };

/** Bound from `schemas/platform/v1.schema.json`. */
const MAX_CLONE_URL_LENGTH = 512;
const MAX_CLONE_URLS = 8;
const MAX_CANONICAL_LENGTH = 255;

/** The canonical form the schema accepts. Kept in step with the schema by test. */
const CANONICAL_PATTERN = /^[a-z0-9][a-z0-9.-]*(:[0-9]{1,5})?(\/[A-Za-z0-9._~-]+)+$/u;

/** Schemes a clone URL may carry. `file` is absent deliberately. */
const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  https: "443",
  http: "80",
  ssh: "22",
  git: "9418",
};

/**
 * Reduces one clone URL to the canonical form.
 *
 * Handles the three shapes in use: an ordinary URL, Git's scp-like
 * `user@host:path`, and the bare `host/path` a human types.
 */
export function canonicaliseCloneUrl(
  raw: string,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: RepositoryIdentityFailure } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  if (trimmed.length > MAX_CLONE_URL_LENGTH) return { ok: false, reason: "too_long" };
  // Control characters and whitespace never belong in a remote, and a value
  // carrying one is far more likely to be a paste accident than a repository.
  // eslint-disable-next-line no-control-regex -- refusing them is the point
  if (/[\s\x00-\x1f\x7f]/u.test(trimmed)) return { ok: false, reason: "invalid_characters" };

  const withScheme = /^(?<scheme>[A-Za-z][A-Za-z0-9+.-]*):\/\/(?<rest>.*)$/u.exec(trimmed);
  let authority: string;
  let path: string;
  let scheme: string | null = null;

  if (withScheme !== null) {
    scheme = (withScheme.groups?.["scheme"] ?? "").toLowerCase();
    if (!(scheme in DEFAULT_PORTS)) return { ok: false, reason: "unsupported_scheme" };
    const rest = withScheme.groups?.["rest"] ?? "";
    const slash = rest.indexOf("/");
    authority = slash === -1 ? rest : rest.slice(0, slash);
    path = slash === -1 ? "" : rest.slice(slash + 1);
  } else if (/^[^/@]*@[^/:]+:/u.test(trimmed) || /^[^/:@]+:(?![0-9]+(\/|$))/u.test(trimmed)) {
    // scp-like: `git@host:example/repo.git`, or `host:example/repo.git`. The
    // negative lookahead keeps `host:8443/path` out of this branch, because a
    // port there is a port and not the start of a path.
    const colon = trimmed.indexOf(":");
    authority = trimmed.slice(0, colon);
    path = trimmed.slice(colon + 1);
    scheme = "ssh";
  } else {
    const slash = trimmed.indexOf("/");
    if (slash === -1) return { ok: false, reason: "missing_path" };
    authority = trimmed.slice(0, slash);
    path = trimmed.slice(slash + 1);
  }

  // The credential half of an authority is dropped, never stored.
  const at = authority.lastIndexOf("@");
  let host = at === -1 ? authority : authority.slice(at + 1);
  if (host === "") return { ok: false, reason: "missing_host" };

  let port = "";
  const portMatch = /^(?<name>.+):(?<port>[0-9]{1,5})$/u.exec(host);
  if (portMatch !== null) {
    host = portMatch.groups?.["name"] ?? host;
    port = portMatch.groups?.["port"] ?? "";
    if (scheme !== null && DEFAULT_PORTS[scheme] === port) port = "";
  }
  host = host.toLowerCase();

  const segments = path
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
  if (segments.length === 0) return { ok: false, reason: "missing_path" };
  const last = segments[segments.length - 1] as string;
  segments[segments.length - 1] = last.replace(/\.git$/iu, "");
  if (segments[segments.length - 1] === "") return { ok: false, reason: "missing_path" };

  const canonical = `${host}${port === "" ? "" : `:${port}`}/${segments.join("/")}`;
  if (canonical.length > MAX_CANONICAL_LENGTH) return { ok: false, reason: "too_long" };
  if (!CANONICAL_PATTERN.test(canonical)) return { ok: false, reason: "invalid_characters" };
  return { ok: true, value: canonical };
}

/**
 * Removes credential material from a clone URL without otherwise rewriting it.
 *
 * What counts as a credential depends on the transport, and getting that
 * distinction wrong in either direction is a real fault:
 *
 * * Over **SSH**, `git@github.com:…` and `ssh://git@host/…` name the *account
 *   to log in as*. The secret is a key on disk and is never in the URL, so a
 *   bare username is kept — dropping it would store a URL that does not clone.
 *   A `user:password` pair still goes, because a password in an SSH URL is a
 *   credential whatever the transport.
 * * Over **every other scheme**, the whole `userinfo` component goes, colon or
 *   no colon. `https://ghp_…@github.com/example/repo.git` is how every forge
 *   documents cloning with a personal access token, so a bare userinfo there is
 *   overwhelmingly a secret rather than an account name; and `git://` is the
 *   unauthenticated daemon protocol, which has no credential mechanism at all,
 *   so a userinfo there cannot be an account to log in as and is an accidental
 *   paste. Keeping either because it held no colon is exactly the mistake that
 *   put a token in a stored, API-returned field (RVP-12 review, F2 and its
 *   third round). What is left still identifies the same repository, and
 *   `docs/SECURITY.md` section 18 does not permit the alternative.
 *
 * The test is therefore "is this SSH?" rather than a list of the schemes that
 * carry secrets. Enumerating them is what left `git://` behind, and it would
 * leave behind whatever scheme is accepted next: an unrecognised scheme is
 * treated as secret-bearing, which is the direction that is safe to be wrong
 * in.
 *
 * The rule errs towards deletion: an operator who loses a username from a URL
 * has a URL to correct, and one who does not lose a token has a token in a
 * database, in every backup of it, and on the screen of anyone who opens the
 * project.
 */
export function sanitiseCloneUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^(?<scheme>[A-Za-z][A-Za-z0-9+.-]*):\/\/(?<userinfo>[^/@]*@)?(?<rest>.*)$/u.exec(trimmed);
  if (withScheme !== null) {
    const scheme = (withScheme.groups?.["scheme"] ?? "").toLowerCase();
    const userinfo = withScheme.groups?.["userinfo"] ?? "";
    const carriesSecret = scheme !== "ssh" || userinfo.includes(":");
    const keep = carriesSecret ? "" : userinfo;
    return `${scheme}://${keep}${withScheme.groups?.["rest"] ?? ""}`;
  }
  // scp-like `user@host:path`, which Git only ever speaks over SSH.
  const scpLike = /^(?<userinfo>[^/@]*@)(?<rest>.*)$/u.exec(trimmed);
  if (scpLike !== null) {
    const userinfo = scpLike.groups?.["userinfo"] ?? "";
    const keep = userinfo.includes(":") ? "" : userinfo;
    return `${keep}${scpLike.groups?.["rest"] ?? ""}`;
  }
  return trimmed;
}

/**
 * Normalises what an operator supplied into the stored identity.
 *
 * Every supplied form must reduce to the same canonical value: two clone URLs
 * for different repositories are a mistake, and storing the first one silently
 * would associate a project with code it does not hold.
 */
export function normaliseRepositoryIdentity(input: RepositoryIdentityInput): RepositoryIdentityResult {
  const supplied: string[] =
    typeof input === "string"
      ? [input]
      : [...(input.canonical === undefined ? [] : [input.canonical]), ...(input.clone_urls ?? [])];

  const present = supplied.map((value) => value.trim()).filter((value) => value !== "");
  if (present.length === 0) return { ok: false, reason: "empty" };
  if (present.length > MAX_CLONE_URLS) return { ok: false, reason: "too_many_clone_urls" };

  let canonical: string | null = null;
  const cloneUrls: string[] = [];
  for (const value of present) {
    const reduced = canonicaliseCloneUrl(value);
    if (!reduced.ok) return reduced;
    if (canonical === null) canonical = reduced.value;
    else if (canonical !== reduced.value) return { ok: false, reason: "inconsistent_urls" };
    // The canonical form is stored in its own member; repeating it in the URL
    // list adds nothing, and a duplicate would fail the schema's uniqueness.
    // What is stored is the sanitised form: a password pasted into a remote is
    // dropped here rather than written to a row that a later screen displays.
    const stored = sanitiseCloneUrl(value);
    if (stored !== reduced.value && !cloneUrls.includes(stored)) cloneUrls.push(stored);
  }
  if (canonical === null) return { ok: false, reason: "empty" };
  return { ok: true, value: { canonical, clone_urls: cloneUrls } };
}
