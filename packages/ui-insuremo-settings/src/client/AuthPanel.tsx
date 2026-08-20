import type { ReactNode } from "react";
import type { ImoOverviewView } from "./overview.ts";
import type { InsuremoLocaleKey } from "./locales.ts";

export interface AuthPanelProps {
  readonly t: (key: InsuremoLocaleKey) => string;
  readonly auth: ImoOverviewView["auth"];
}

/** Sanitized auth profile table (env / tenant only; never a token). */
export function AuthPanel({ t, auth }: AuthPanelProps): ReactNode {
  if (auth.profiles.length === 0) {
    return (
      <section aria-labelledby="overview-auth-title">
        <h3 id="overview-auth-title">{t("authTitle")}</h3>
        <p>{t("authNone")}</p>
      </section>
    );
  }
  return (
    <section aria-labelledby="overview-auth-title">
      <h3 id="overview-auth-title">{t("authTitle")}</h3>
      <p>
        {t("authProfiles")}: {auth.count} · {t("authDefault")}: {auth.defaultProfile ?? t("authNone")}
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">{t("authColumn")}</th>
            <th scope="col">{t("envColumn")}</th>
            <th scope="col">{t("tenantColumn")}</th>
            <th scope="col">{t("validColumn")}</th>
          </tr>
        </thead>
        <tbody>
          {auth.profiles.map(profile => (
            <tr key={profile.name}>
              <th scope="row">{profile.name}{profile.isDefault ? ` (${t("authDefault")})` : ""}</th>
              <td>{profile.env ?? "—"}</td>
              <td>{profile.tenantCode ?? "—"}</td>
              <td>{profile.valid === undefined ? "—" : (profile.valid ? t("authValid") : t("authInvalid"))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
