import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, MapPin, ExternalLink } from "lucide-react";
import { format } from "date-fns";
import { uk, enGB } from "date-fns/locale";
import { incidentDate, type Incident } from "@crime-radar/shared";
import { localized, safeSourceUrl } from "../services";
import { CategoryIcon } from "./Icon";
export function IncidentDate({ incident }: { incident: Incident }) {
  const { t, i18n } = useTranslation();
  const date = incidentDate(incident);
  return (
    <>
      <span>
        {t(
          incident.occurredAt
            ? "occurred"
            : incident.reportedAt
              ? "reported"
              : incident.publishedAt
                ? "published"
                : "unknownDate",
        )}
      </span>
      {date && (
        <time dateTime={date}>
          {format(new Date(date), "d MMM yyyy · HH:mm", {
            locale: i18n.language === "uk" ? uk : enGB,
          })}
        </time>
      )}
    </>
  );
}
export function IncidentCard({
  incident,
  full = false,
}: {
  incident: Incident;
  full?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  return (
    <div className="incident-card">
      <div className="incident-heading">
        <CategoryIcon category={incident.category} />
        <span className="eyebrow">
          {t(`incidents:category.${incident.category}`)}
        </span>
      </div>
      <h2>{localized(incident.title, locale)}</h2>
      <div className="date-info">
        <IncidentDate incident={incident} />
      </div>
      <div className="location-info">
        <MapPin size={17} />
        <span>
          {locale === "en"
            ? incident.location.cityEn || incident.location.city
            : incident.location.city}
          {incident.location.district && ` · ${incident.location.district}`}
        </span>
      </div>
      {incident.location.approximate && (
        <p className="subtle small">
          {t(
            incident.location.precision === "city"
              ? "cityCentre"
              : "approximate",
          )}
        </p>
      )}
      <p className="incident-description">
        {localized(incident.description, locale)}
      </p>
      {incident.legalQualification?.article && (
        <div className="detail-row">
          <span>{t("legal")}</span>
          <strong>
            {t("article", { article: incident.legalQualification.article })}
          </strong>
        </div>
      )}
      {incident.status && (
        <div className="detail-row">
          <span>{t("status")}</span>
          <strong>
            {t(
              `status${incident.status[0].toUpperCase()}${incident.status.slice(1)}`,
            )}
          </strong>
        </div>
      )}
      <h3 className="section-label">{t("source")}</h3>
      {incident.sources.map((source, index) => {
        const url = safeSourceUrl(source.url);
        return (
          <div key={index} className="source-row">
            {url ? (
              <a href={url} target="_blank" rel="noopener noreferrer">
                {source.name}
                <ExternalLink size={15} />
              </a>
            ) : (
              <>
                <span>{source.name}</span>
                <span className="subtle small">{t("noSourceLink")}</span>
              </>
            )}
          </div>
        );
      })}
      {full ? (
        <div className="keywords">
          {incident.keywords.map((k) => (
            <span key={k}>{k}</span>
          ))}
        </div>
      ) : (
        <Link className="primary-button" to={`/incident/${incident.id}`}>
          {t("details")}
          <ArrowUpRight size={18} />
        </Link>
      )}
    </div>
  );
}
