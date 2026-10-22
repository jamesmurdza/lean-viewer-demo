import Mathlib

/-
Let (M, d) be a metric space. For a set A ⊆ M, the diameter is
  diam(A) := sup { d(x, y) : x, y ∈ A }.

Claim: if A, B ⊆ M with A ∩ B ≠ ∅, then
  diam(A ∪ B) ≤ diam(A) + diam(B).

Mathlib already has this exact fact as `Metric.diam_union'`, but we
reprove it by hand below (`diam_union_of_inter_nonempty`) to spell out
the triangle-inequality argument explicitly, the same way you'd write
it on paper:

  * If x, y are both in A (or both in B), the bound is immediate from
    the definition of diameter.
  * If x ∈ A and y ∈ B, pick a common point z ∈ A ∩ B and use the
    triangle inequality: d(x, y) ≤ d(x, z) + d(z, y) ≤ diam(A) + diam(B),
    since x, z ∈ A and z, y ∈ B.

Mathlib's `Metric.diam` is real-valued (as opposed to `Metric.ediam`,
which lives in ℝ≥0∞), so to avoid the "junk value" issue for unbounded
sets we assume A and B are bounded — exactly the case where "diameter"
means what you'd expect.
-/

open Metric Bornology

variable {M : Type*} [PseudoMetricSpace M] {A B : Set M}

theorem diam_union_of_inter_nonempty
    (hA : IsBounded A) (hB : IsBounded B) (hAB : (A ∩ B).Nonempty) :
    diam (A ∪ B) ≤ diam A + diam B := by
  obtain ⟨z, hzA, hzB⟩ := hAB
  apply diam_le_of_forall_dist_le (by linarith [diam_nonneg (s := A), diam_nonneg (s := B)])
  rintro x (hx | hx) y (hy | hy)
  -- x, y ∈ A
  · calc dist x y ≤ diam A := dist_le_diam_of_mem hA hx hy
      _ ≤ diam A + diam B := by linarith [diam_nonneg (s := B)]
  -- x ∈ A, y ∈ B: bridge through z ∈ A ∩ B
  · calc dist x y ≤ dist x z + dist z y := dist_triangle x z y
      _ ≤ diam A + diam B := by
          have h1 : dist x z ≤ diam A := dist_le_diam_of_mem hA hx hzA
          have h2 : dist z y ≤ diam B := dist_le_diam_of_mem hB hzB hy
          linarith
  -- x ∈ B, y ∈ A: symmetric to the previous case
  · calc dist x y ≤ dist x z + dist z y := dist_triangle x z y
      _ ≤ diam A + diam B := by
          have h1 : dist x z ≤ diam B := dist_le_diam_of_mem hB hx hzB
          have h2 : dist z y ≤ diam A := dist_le_diam_of_mem hA hzA hy
          linarith
  -- x, y ∈ B
  · calc dist x y ≤ diam B := dist_le_diam_of_mem hB hx hy
      _ ≤ diam A + diam B := by linarith [diam_nonneg (s := A)]

-- Sanity check against Mathlib's own version of the same statement.
example (hAB : (A ∩ B).Nonempty) : diam (A ∪ B) ≤ diam A + diam B :=
  diam_union' hAB
