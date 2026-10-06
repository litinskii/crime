import type { SourceDefinition } from "./types";

export const sources: SourceDefinition[] = [
  {
    id: "npu-telegram",
    name: "Національна поліція України",
    kind: "official",
    transport: "telegram",
    url: "https://t.me/s/UA_National_Police",
    verificationUrl:
      "https://if.npu.gov.ua/news/natspolitsiya-zapustila-shche-odin-nomer-garyachoi-linii-z-poshuku-zniklikh-chi-zagiblikh-vnaslidok-viyskovikh-diy-rf-v-ukraini",
  },
  {
    id: "patrol-rss",
    name: "Патрульна поліція України",
    kind: "official",
    transport: "rss",
    url: "https://patrolpolice.gov.ua/feed/",
    verificationUrl: "https://patrolpolice.gov.ua/",
  },
  {
    id: "ukrinform-regions",
    name: "Укрінформ",
    kind: "media",
    transport: "rss",
    url: "https://www.ukrinform.ua/rss/rubric-regions",
    verificationUrl: "https://www.ukrinform.ua/",
    archiveUrl: "https://www.ukrinform.ua/rubric-regions/block-lastnews",
  },
  {
    id: "zaxid-news",
    name: "ZAXID.NET",
    kind: "media",
    transport: "rss",
    url: "https://zaxid.net/rss/1.xml",
    verificationUrl: "https://zaxid.net/home/showRss.do",
  },
  {
    id: "npu-news",
    name: "Нацполіція — вебсайт",
    kind: "official",
    transport: "police-web",
    url: "https://npu.gov.ua/timeline?type=posts",
    verificationUrl: "https://npu.gov.ua/",
  },
  {
    id: "kyiv-police-news",
    name: "Поліція Києва",
    kind: "official",
    transport: "police-web",
    url: "https://kyiv.npu.gov.ua/timeline?type=posts",
    verificationUrl: "https://kyiv.npu.gov.ua/",
  },
  {
    id: "lviv-police-news",
    name: "Поліція Львівщини",
    kind: "official",
    transport: "police-web",
    url: "https://lv.npu.gov.ua/timeline?type=posts",
    verificationUrl: "https://lv.npu.gov.ua/",
  },
  {
    id: "court-decisions",
    name: "Єдиний державний реєстр судових рішень",
    kind: "court",
    transport: "court",
    url: "https://data.gov.ua/dataset/ediniy-derzhavniy-reestr-sudovih-rishen-za-2026-rik_7636",
    verificationUrl:
      "https://data.gov.ua/organization/derzhavna-sudova-administratsiia-ukrayiny",
  },
];
export const sourceById = (id: string) =>
  sources.find((source) => source.id === id);
export const scheduledSources = sources.filter(
  (source) => source.transport !== "court",
);
