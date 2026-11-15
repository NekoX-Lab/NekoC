function double(x: number) {
  return x * 2;
}

test("double", () => {
  expect(double(21)).toBe(42);
});

test("binary digits", () => {
  // Nondecimal toString requires a constant receiver and radix.
  expect((13).toString(2)).toBe("1101");
  expect([1, 2, 3]).toContain(2);
});
