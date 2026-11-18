import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { installGlobalErrorHandlers } from "./lib/app/globalErrors";
import { applySystemTheme } from "./lib/app/theme";
import { describeAppError } from "./lib/ipc/errors";
import { reportFirstPaint } from "./lib/perf/firstPaint";
import { toast } from "./lib/tree/toast.svelte";

// Yerel `catch` bloklarının kaçırdığı hatalar da kullanıcıya ulaşır: tipli
// koda normalize edilir ve aynı Türkçe, eylem odaklı toast metniyle gösterilir.
// Montajdan önce kurulur; toast deposu modül düzeyinde olduğu için montaj
// sırasında oluşan hata da ilk karede görünür.
const reportError = (error: unknown): void => {
  toast.error(describeAppError(error));
};

installGlobalErrorHandlers(window, reportError);

const target = document.getElementById("app");

if (!target) {
  throw new Error("Uygulama koku (#app) bulunamadi.");
}

// Tema montajdan önce uygulanır: koyu varsayılanla boyanıp açığa dönmez.
// Dinleyiciler (medya sorgusu + pencere teması olayı) `App` içinde kurulur.
applySystemTheme();

const app = mount(App, { target });

// Performans ölçümü yalnızca üretim derlemesinde çalışır: iki `rAF` sonrası
// ilk kare çizilmiştir. Geliştirme sunucusunda ölçüm gürültüsü istenmez.
// Reddedilen ölçüm sahipsiz bırakılmaz: aynı tipli raporlayıcıya verilir.
if (import.meta.env.PROD) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      void reportFirstPaint().catch(reportError);
    });
  });
}

export default app;
