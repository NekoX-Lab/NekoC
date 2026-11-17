let sel: number | null = 1;
function useSel(n: number): number { return n * 2; }
function loop(): void {
  while (true) {
    if (sel !== null) { console.log(useSel(sel)); }
    sel = null;
    break;
  }
}
loop();
