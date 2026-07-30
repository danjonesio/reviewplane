/**
 * First run and sign-in (`docs/UX_FLOWS.md` section 4, `docs/SECURITY.md`
 * section 6.1).
 *
 * One screen with two states, because they are the same moment for the person
 * looking at it: an installation nobody has claimed asks for the one-time token
 * the operator minted and the account to create; a claimed one asks for the
 * email address and password.
 *
 * The accessibility requirements of `docs/UX_FLOWS.md` section 19 are not
 * decoration on a login screen — it is the one page every user meets, and the
 * one page a keyboard user cannot skip. So: every control has a real `<label>`,
 * the failure is an `alert` region that names the field, the submit button
 * reports its own progress, and nothing depends on colour.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactElement } from "react";

import { ApiFailure, api } from "../api/client.ts";
import { BOOTSTRAP_QUERY_KEY, SESSION_QUERY_KEY } from "../auth/session.ts";
import type { BootstrapStatus } from "../api/client.ts";

const FIELD =
  "rounded border border-slate-400 bg-white px-3 py-2 text-base dark:border-slate-600 dark:bg-slate-900";
const BUTTON =
  "self-start rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-60";

export function SignIn({ status }: { readonly status: BootstrapStatus | undefined }): ReactElement {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");

  const claiming = status?.bootstrap_required === true;

  const submit = useMutation({
    mutationFn: async () =>
      claiming ? api.bootstrap({ token, email, password }) : api.signIn({ email, password }),
    onSuccess: async () => {
      setPassword("");
      setToken("");
      await queryClient.invalidateQueries({ queryKey: BOOTSTRAP_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    },
  });

  const failure = submit.error;
  const message =
    failure instanceof ApiFailure
      ? failure.message
      : failure === null
        ? null
        : "The request could not be completed.";

  return (
    <section aria-labelledby="sign-in-heading" className="mx-auto max-w-xl">
      <h1 id="sign-in-heading" className="text-xl font-semibold">
        {claiming ? "Set up this installation" : "Sign in"}
      </h1>
      <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
        {claiming
          ? "This deployment has no administrator yet. Paste the one-time installation token from reviewplane install-token and choose the account you will sign in with. The token can be used once and expires."
          : "ReviewPlane is self-hosted. Your password never leaves this deployment, and the session cookie it issues cannot be read by a script."}
      </p>

      <form
        className="mt-6 flex flex-col gap-4"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          submit.mutate();
        }}
      >
        {claiming ? (
          <div className="flex flex-col gap-2">
            <label htmlFor="install-token" className="text-sm font-medium">
              Installation token
            </label>
            <input
              id="install-token"
              name="install-token"
              type="password"
              autoComplete="off"
              required
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
              }}
              className={`${FIELD} font-mono`}
              aria-describedby="install-token-hint"
            />
            <p id="install-token-hint" className="text-xs text-slate-600 dark:text-slate-400">
              Run <code>reviewplane install-token</code> on the deployment to mint one. It is shown
              once.
            </p>
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <label htmlFor="email" className="text-sm font-medium">
            Email address
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete={claiming ? "username" : "email"}
            required
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
            className={FIELD}
          />
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="password" className="text-sm font-medium">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete={claiming ? "new-password" : "current-password"}
            required
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            className={FIELD}
            {...(claiming ? { "aria-describedby": "password-hint", minLength: 12 } : {})}
          />
          {claiming ? (
            <p id="password-hint" className="text-xs text-slate-600 dark:text-slate-400">
              At least 12 characters. Length is the only rule, so a passphrase is fine.
            </p>
          ) : null}
        </div>

        <button type="submit" className={BUTTON} disabled={submit.isPending}>
          {submit.isPending ? "Working…" : claiming ? "Create administrator" : "Sign in"}
        </button>

        {message === null ? null : (
          <p role="alert" className="text-sm font-medium text-red-800 dark:text-red-300">
            {message}
          </p>
        )}
      </form>
    </section>
  );
}
