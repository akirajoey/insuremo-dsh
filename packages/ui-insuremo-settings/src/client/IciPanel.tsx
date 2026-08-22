import type { ReactNode } from "react";
import type { ImoOverviewView } from "./overview.ts";
import type { InsuremoLocaleKey } from "./locales.ts";

type Translate = (key: InsuremoLocaleKey) => string;

/**
 * Read-only Code Intelligence summary: effective embedding endpoint (config-
 * derived; the settings page deliberately offers no editable field — changing
 * it means editing the profile/bundle config, which the hint explains) plus
 * graph/explain adoption counts.
 */
export function IciPanel(props: { t: Translate; ici: NonNullable<ImoOverviewView["ici"]> }): ReactNode {
  const { t, ici } = props;
  return (
    <section aria-labelledby="insuremo-ici-title">
      <h3 id="insuremo-ici-title">{t("iciTitle")}</h3>
      <dl>
        <div>
          <dt>{t("iciEmbeddingEndpoint")}</dt>
          <dd>
            <code>{ici.embeddingUrl}</code>
            <p>{t("iciEmbeddingHint")}</p>
          </dd>
        </div>
        <div>
          <dt>{t("iciGraphWorkspaces")}</dt>
          <dd>{ici.graphWorkspaces}</dd>
        </div>
        <div>
          <dt>{t("iciExplainWorkspaces")}</dt>
          <dd>{ici.explainWorkspaces}</dd>
        </div>
      </dl>
    </section>
  );
}
