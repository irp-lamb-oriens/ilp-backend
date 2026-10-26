import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { maskEmails } from "../helper/log.ts";

Deno.test("log masks email addresses but keeps the domain", () => {
  assertEquals(maskEmails("OTP sent to ana.maria+x@example.co.cr"), "OTP sent to a***@example.co.cr");
  assertEquals(maskEmails("a@b.io and Bob@ILP.com"), "a***@b.io and B***@ILP.com");
  assertEquals(maskEmails("quote q_1 accepted on cl_9"), "quote q_1 accepted on cl_9");
});
