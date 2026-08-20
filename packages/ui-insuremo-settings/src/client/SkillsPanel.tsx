import type { ReactNode } from "react";
import type { ImoOverviewView } from "./overview.ts";
import type { InsuremoLocaleKey } from "./locales.ts";

export interface SkillsPanelProps {
  readonly t: (key: InsuremoLocaleKey) => string;
  readonly skills: ImoOverviewView["skills"];
}

/** Read-only installed/enabled/disabled skill counts and bounded names. */
export function SkillsPanel({ t, skills }: SkillsPanelProps): ReactNode {
  return (
    <section aria-labelledby="overview-skills-title">
      <h3 id="overview-skills-title">{t("skillsTitle")}</h3>
      <table aria-label={t("skillsTitle")}>
        <tbody>
          <tr><th scope="row">{t("skillsInstalled")}</th><td>{skills.installed}</td></tr>
          <tr><th scope="row">{t("skillsValid")}</th><td>{skills.valid}</td></tr>
          <tr><th scope="row">{t("skillsEnabled")}</th><td>{skills.enabled}</td></tr>
          <tr><th scope="row">{t("skillsDisabled")}</th><td>{skills.disabled}</td></tr>
        </tbody>
      </table>
      {skills.names.length === 0 ? (
        <p>{t("skillsNone")}</p>
      ) : (
        <details>
          <summary>{t("skillsNames")}</summary>
          <ul>
            {skills.names.map(name => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
