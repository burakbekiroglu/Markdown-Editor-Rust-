<script lang="ts">
  /**
   * Kenar çubuğu ayırıcısı.
   *
   * Genişliğin sahibi kabuk bileşenidir; bu bileşen yalnızca sınırlar içinde
   * yeni bir değer önerir. Fare/sürükleme, dokunma (pointer yakalama) ve
   * klavye (ok tuşları, Home/End) aynı `onResize` yolunu kullanır.
   *
   * Taşıyıcı odaklanabilir bir `div`'dir: `role="separator"` + `aria-valuenow`
   * pencere ayırıcısının ARIA sözleşmesidir; `tabindex="0"` klavye odağını
   * verir. Svelte'in `a11y_no_noninteractive_element_interactions` uyarısı bu
   * standart desende yanlış pozitiftir; semantik doğru tutulur.
   */
  let {
    width,
    min,
    max,
    step = 16,
    label = 'Kenar çubuğu genişliği',
    onResize,
  }: {
    width: number;
    min: number;
    max: number;
    step?: number;
    label?: string;
    onResize: (width: number) => void;
  } = $props();

  let handle = $state<HTMLDivElement | null>(null);
  let drag = $state<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  function clamp(value: number): number {
    return Math.min(max, Math.max(min, Math.round(value)));
  }

  function startDrag(event: PointerEvent): void {
    if (event.button !== 0) return;
    handle?.focus();
    drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
    handle?.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent): void {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    onResize(clamp(drag.startWidth + event.clientX - drag.startX));
  }

  function endDrag(event: PointerEvent): void {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    drag = null;
    if (handle?.hasPointerCapture(event.pointerId) === true) {
      handle.releasePointerCapture(event.pointerId);
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = width - step;
        break;
      case 'ArrowRight':
        next = width + step;
        break;
      case 'Home':
        next = min;
        break;
      case 'End':
        next = max;
        break;
      default:
        return;
    }
    event.preventDefault();
    onResize(clamp(next));
  }
</script>

<div
  class="splitter"
  class:dragging={drag !== null}
  role="separator"
  aria-orientation="vertical"
  aria-label={label}
  aria-valuemin={min}
  aria-valuemax={max}
  aria-valuenow={width}
  tabindex="0"
  bind:this={handle}
  onpointerdown={startDrag}
  onpointermove={onPointerMove}
  onpointerup={endDrag}
  onpointercancel={endDrag}
  onkeydown={onKeyDown}
></div>

<style>
  .splitter {
    flex: 0 0 auto;
    align-self: stretch;
    width: 5px;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    cursor: col-resize;
    touch-action: none;
  }

  .splitter:hover,
  .splitter.dragging {
    background: var(--border);
  }

  .splitter:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
</style>
