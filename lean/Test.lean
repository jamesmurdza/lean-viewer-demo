import Mathlib

def add (a b : Nat) : Nat := a + b

theorem add_comm_test (a b : Nat) : add a b = add b a := by
  unfold add
  exact Nat.add_comm a b

#eval add 2 3
#check add_comm_test

-- Mathlib is available now:
example (a b : ℝ) : (a + b) ^ 2 = a ^ 2 + 2 * a * b + b ^ 2 := by ring

open Nat in
#check Nat.add_comm
