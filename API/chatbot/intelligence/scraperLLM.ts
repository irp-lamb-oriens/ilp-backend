/**
 * API/chatbot/intelligence/scraperLLM.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Selenium-driven Gemini web-UI fallback for the ILP LLM chain.
 *
 * Ported from IRP-funnel's `API/chatbot/intelligence/scraperLLM.ts`. This is
 * the ultimate fallback when no API key is configured or every API provider
 * has failed: it drives a headless Chrome session against gemini.google.com.
 *
 * Requires `npm:selenium-webdriver` (added to deno.json imports) and a Chrome
 * binary on the host. It is only invoked as a last resort, so the heavy
 * dependency does not affect the normal request path.
 */

import {
  Builder,
  Browser,
  By,
  until,
  type WebDriver,
  type WebElement,
} from "selenium-webdriver";
import { Options } from "selenium-webdriver/chrome.js";
import log from "../../../helper/log.ts";

export type Role = "system" | "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
}

export interface CompletionRequest {
  messages: Message[];
  fields?: string[];
}

let driverInstance: WebDriver | null = null;

export async function initBrowser() {
  if (!driverInstance) {
    log("[SCRAPER] Initializing Chrome WebDriver...");
    const options = new Options();
    options.addArguments("--window-size=1200,1000");
    options.addArguments("--disable-blink-features=AutomationControlled");
    options.addArguments("--headless=new");
    options.addArguments("--no-sandbox");
    options.addArguments("--disable-dev-shm-usage");
    options.addArguments("--disable-gpu");
    options.excludeSwitches("enable-automation");

    driverInstance = await new Builder()
      .forBrowser(Browser.CHROME)
      .setChromeOptions(options)
      .build();

    await driverInstance.get("https://gemini.google.com/app");
    await waitForElement(driverInstance, "div.ql-editor", 60000);
    log("[SCRAPER] Chat box found. System ready.");
  }
  return driverInstance;
}

export async function closeBrowser() {
  if (driverInstance) {
    await driverInstance.quit();
    driverInstance = null;
  }
}

export async function resetChat() {
  const driver = await initBrowser();
  await driver.get("https://gemini.google.com/app");
  await waitForElement(driver, "div.ql-editor", 60000);
}

async function waitForElement(
  driver: WebDriver,
  selector: string,
  timeoutMs = 60000,
): Promise<WebElement> {
  const element = await driver.wait(until.elementLocated(By.css(selector)), timeoutMs);
  await driver.wait(until.elementIsVisible(element), timeoutMs);
  return element;
}

async function waitForAndExtractGeminiResponse(driver: WebDriver): Promise<string> {
  let previousText = "";
  let stableCount = 0;
  let attempt = 0;

  await new Promise((r) => setTimeout(r, 3000));

  while (true) {
    try {
      const responseElements = await driver.findElements(
        By.css("message-content, .markdown, .model-response-text"),
      );
      if (responseElements.length > 0) {
        const lastResponse = responseElements[responseElements.length - 1];
        const currentText = await lastResponse.getText();
        if (currentText && currentText.length > 0) {
          if (currentText === previousText) {
            stableCount++;
          } else {
            stableCount = 0;
            previousText = currentText;
          }
          if (stableCount >= 3) {
            return currentText;
          }
        }
      }
    } catch {
      // Ignore stale element reference errors while the DOM updates.
    }

    attempt++;
    if (attempt > 80) {
      log("[SCRAPER] Timed out waiting for Gemini text to stabilize.");
      return previousText;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

function extractJsonFromDashBlock(text: string): string | null {
  const dashMatch = text.match(/---\s*(\{[\s\S]*?\})\s*---/);
  if (dashMatch && dashMatch[1]) return dashMatch[1];
  const jsonRegex = /\{(?:[^{}]|R)*\}/;
  const match = text.match(jsonRegex);
  return match ? match[0] : null;
}

function compileMessages(messages: Message[]): string {
  let compiled =
    "Please read the following conversation history and strictly adopt the persona defined in the SYSTEM instructions. Then, respond to the final USER message.\n\n";
  compiled += "=== CONVERSATION HISTORY ===\n";
  for (const msg of messages) {
    compiled += `[${msg.role.toUpperCase()}]: ${msg.content}\n\n`;
  }
  compiled += "=== END HISTORY ===\n\n";
  compiled += "Now, generate the next response as the ASSISTANT.";
  return compiled;
}

export async function callLLM(
  userInput: string,
  fieldsArray?: string[],
): Promise<Record<string, string> | string> {
  const driver = await initBrowser();
  const requiresJson = fieldsArray && fieldsArray.length > 0;

  let finalPrompt = userInput;
  if (requiresJson) {
    finalPrompt = `${userInput}\n\nExpected response format should be only like this without prefix or suffix other than surrounded by ---...--- something like this:\n---\n{\n${fieldsArray!.map((field) => `"${field}": "Your ${field} response value"`).join(",\n")}\n}\n---`;
  }

  try {
    const textArea = await waitForElement(driver, "div.ql-editor", 60000);

    await driver.executeScript(
      (el: { focus: () => void; innerText: string; dispatchEvent: (e: Event) => boolean }, text: string) => {
        el.focus();
        el.innerText = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      },
      textArea,
      finalPrompt,
    );

    await new Promise((r) => setTimeout(r, 2000));

    const sendBtn = await waitForElement(driver, "button[aria-label*='Send']");
    await sendBtn.click();

    const rawAiResponse = await waitForAndExtractGeminiResponse(driver);
    if (!rawAiResponse) {
      throw new Error("Failed to extract text from the UI.");
    }

    if (!requiresJson) return rawAiResponse;

    const extractedJsonString = extractJsonFromDashBlock(rawAiResponse);
    if (!extractedJsonString) {
      throw new Error("Could not find valid JSON block surrounded by --- in the response.");
    }
    return JSON.parse(extractedJsonString);
  } catch (error) {
    log(`[SCRAPER] Error in execution: ${error instanceof Error ? error.message : error}`);
    throw error;
  }
}

export class GeminiWebAdapter {
  async createCompletion(
    request: CompletionRequest,
  ): Promise<Record<string, string> | string> {
    const masterPrompt = compileMessages(request.messages);
    await resetChat();
    return await callLLM(masterPrompt, request.fields);
  }
}