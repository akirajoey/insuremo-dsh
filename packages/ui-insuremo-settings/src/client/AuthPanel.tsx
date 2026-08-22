import { Component, type ReactNode } from "react";
import type { ImoOverviewView } from "./overview.ts";
import type { InsuremoLocaleKey } from "./locales.ts";
import { postAction } from "./actions.ts";

export interface AuthPanelProps {
  readonly t: (key: InsuremoLocaleKey) => string;
  readonly auth: ImoOverviewView["auth"];
  /** Called after a successful default switch so the section refetches. */
  readonly onChanged?: () => void;
}

/** Auth profile table with a default-profile radio switch (no login flow — CLI hint). */
export class AuthPanel extends Component<AuthPanelProps, { error?: string; busy: boolean }> {
  override state: { error?: string; busy: boolean } = { busy: false };

  private async setDefault(name: string): Promise<void> {
    this.setState({ busy: true, error: undefined });
    const outcome = await postAction<{ status: string; profile: string }>("default-profile", { profile: name });
    this.setState({ busy: false });
    if (outcome.ok) this.props.onChanged?.();
    else {
      const network = outcome.error.code === "network";
      this.setState({ error: network ? this.props.t("errorNetwork") : `${outcome.error.code}: ${outcome.error.message}` });
    }
  }

  override render(): ReactNode {
    const { t, auth } = this.props;
    return (
      <section aria-labelledby="overview-auth-title">
        <h3 id="overview-auth-title">{t("authTitle")}</h3>
        {auth.profiles.length === 0 ? <p>{t("authNone")}</p> : (
          <>
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
                  <th scope="col">{t("authSetDefault")}</th>
                </tr>
              </thead>
              <tbody>
                {auth.profiles.map(profile => (
                  <tr key={profile.name}>
                    <th scope="row">{profile.name}{profile.isDefault ? ` (${t("authDefault")})` : ""}</th>
                    <td>{profile.env ?? "—"}</td>
                    <td>{profile.tenantCode ?? "—"}</td>
                    <td>{profile.valid === undefined ? "—" : (profile.valid ? t("authValid") : t("authInvalid"))}</td>
                    <td>
                      <input
                        type="radio"
                        name="insuremo-default-profile"
                        checked={profile.isDefault}
                        disabled={this.state.busy}
                        onChange={() => void this.setDefault(profile.name)}
                        aria-label={`${t("authSetDefault")}: ${profile.name}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {this.state.error !== undefined ? <p role="alert" style={{ color: "#c0392b" }}>{this.state.error}</p> : null}
        <p>{t("authCliHint")}</p>
      </section>
    );
  }
}
