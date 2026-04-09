async function test() {
  try {
    const res = { ok: false };
    if (!res.ok) {
      console.log("Not ok hit");
      const mockRes = await Promise.reject("Simulated API post error").catch(() => null);
      console.log("Mockres:", mockRes);
      // Fall back to manual entry
      throw new Error("Wait, did it throw here?");
    }
  } catch (err) {
    console.log("Caught:", err.message);
  }
}
test();
