export function formatNok(amountOre: number): string {
  return new Intl.NumberFormat("nb-NO", {
    style: "currency",
    currency: "NOK",
  })
    .format(amountOre / 100)
    .replace(/[\u00a0\u202f]/g, " ");
}
