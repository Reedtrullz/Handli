# Page Dependency Trees

No page source files exist. These are the planned visual dependency trees derived from the approved design specification.

## `/planlegg` — Basket builder

Entry: not implemented

- HandleplanShell
  - BrandMark
  - PrimaryNavigation
  - LocalPreferences
- BasketHeader
- NeedComposer
  - ProductCombobox
  - QuantityControl
- BasketItemCard
  - ProductMatchSummary
  - ConstraintChips
  - MatchConfidence
- TravelOption
- CalculatePlanAction

## `/planlegg/resultat` — Plan results

Entry: not implemented

- HandleplanShell
- PlanSummary
- ConvenienceSavingsSelector
  - AccessiblePlanList
  - PlanMetrics
- StoreRouteSummary
- StoreAssignmentCard
- PriceTrustDisclosure
- ChoosePlanAction

## `/planlegg/handle` — Shopping checklist

Entry: not implemented

- FocusedHandleplanShell
- TripProgress
- StoreChecklistGroup
  - StoreHeader
  - ChecklistItem
  - OfferCondition
- ExpectedTotal
- OfflineState

## `/oppdag` — Discovery

Entry: not implemented

- HandleplanShell
- DiscoveryFilters
- BasketRelevantSection
- OpportunityCard
  - PriceEvidence
  - PlanImpact
  - AddOrReplaceAction
- PriceDropSection
- UnitPriceSection

