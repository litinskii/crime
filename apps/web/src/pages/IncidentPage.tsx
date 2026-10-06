import { lazy, Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Share2, Radar } from "lucide-react";
import { incidentsRepository, isDemo } from "../repositories/incidents";
import { IncidentCard } from "../components/IncidentCard";
const IncidentMap = lazy(() => import("../features/IncidentMap"));
export default function IncidentPage({ dark }: { dark: boolean }) {
  const { id } = useParams();
  const { t } = useTranslation();
  const [notice, setNotice] = useState("");
  const query = useQuery({
    queryKey: ["incident", id],
    queryFn: ({ signal }) => incidentsRepository.getIncident(id!, signal),
    retry: 1,
    networkMode: isDemo ? "always" : "online",
  });
  const share = async () => {
    try {
      if (navigator.share)
        await navigator.share({ title: "Crime Radar", url: location.href });
      else {
        await navigator.clipboard.writeText(location.href);
        setNotice(t("copied"));
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError"))
        setNotice(t("shareFailed"));
    }
  };
  return (
    <main className="details-page">
      <header className="details-header">
        <Link className="icon-button" to="/" aria-label={t("back")}>
          <ArrowLeft size={23} />
        </Link>
        <span>
          <Radar size={23} />
          Crime Radar
        </span>
        <button
          className="icon-button"
          aria-label={t("share")}
          onClick={() => void share()}
        >
          <Share2 size={21} />
        </button>
      </header>
      {query.isPending ? (
        <p>{t("loading")}</p>
      ) : query.isError ? (
        <div className="empty-page">
          <h1>{t("notFound")}</h1>
          <button
            className="primary-button"
            onClick={() => void query.refetch()}
          >
            {t("retry")}
          </button>
          <Link to="/">{t("back")}</Link>
        </div>
      ) : (
        <>
          <div className="incident-mini-map">
            <Suspense fallback={<p>{t("loading")}</p>}>
              <IncidentMap
                incidents={[query.data]}
                mode="markers"
                dark={dark}
                center={[
                  query.data.location.longitude,
                  query.data.location.latitude,
                ]}
                zoom={13}
                onBounds={() => {}}
                onSelect={() => {}}
                onReady={() => {}}
              />
            </Suspense>
          </div>
          <div className="details-content">
            {(isDemo || query.data.synthetic) && (
              <p className="demo-disclaimer">{t("demoNote")}</p>
            )}
            <IncidentCard incident={query.data} full />
            <Link className="primary-button" to="/">
              {t("back")}
            </Link>
            <p className="small subtle">{t("coverage")}</p>
          </div>
        </>
      )}
      {notice && (
        <p role="status" className="status-message">
          {notice}
        </p>
      )}
    </main>
  );
}
