/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";

interface MarkdownProps {
  content: string;
}

export default function Markdown({ content }: MarkdownProps) {
  // Simple, safe, and robust parser for basic Markdown syntax
  const parseMarkdown = (text: string) => {
    const lines = text.split("\n");
    let inList = false;
    const listItems: string[] = [];
    const elements: React.ReactNode[] = [];

    const flushList = (key: string) => {
      if (listItems.length > 0) {
        elements.push(
          <ul key={`list-${key}`} className="list-disc pl-5 my-2 space-y-1 text-inherit">
            {listItems.map((item, idx) => (
              <li key={`li-${key}-${idx}`}>{parseInline(item)}</li>
            ))}
          </ul>
        );
        listItems.length = 0;
      }
      inList = false;
    };

    const parseInline = (inlineText: string): React.ReactNode[] => {
      // Regexes for bold, italic, and inline code
      const tokens: { type: "text" | "bold" | "italic" | "code" | "link"; value: string; extra?: string }[] = [];
      let index = 0;

      while (index < inlineText.length) {
        // Code block check
        if (inlineText.startsWith("`", index)) {
          const nextBacktick = inlineText.indexOf("`", index + 1);
          if (nextBacktick !== -1) {
            tokens.push({ type: "code", value: inlineText.substring(index + 1, nextBacktick) });
            index = nextBacktick + 1;
            continue;
          }
        }

        // Bold check
        if (inlineText.startsWith("**", index)) {
          const nextBold = inlineText.indexOf("**", index + 2);
          if (nextBold !== -1) {
            tokens.push({ type: "bold", value: inlineText.substring(index + 2, nextBold) });
            index = nextBold + 2;
            continue;
          }
        }

        // Italic check
        if (inlineText.startsWith("*", index)) {
          const nextItalic = inlineText.indexOf("*", index + 1);
          if (nextItalic !== -1) {
            tokens.push({ type: "italic", value: inlineText.substring(index + 1, nextItalic) });
            index = nextItalic + 1;
            continue;
          }
        }

        // Markdown link check [text](url)
        if (inlineText.startsWith("[", index)) {
          const closeBracket = inlineText.indexOf("]", index);
          if (closeBracket !== -1 && inlineText.startsWith("(", closeBracket + 1)) {
            const closeParen = inlineText.indexOf(")", closeBracket + 1);
            if (closeParen !== -1) {
              const linkText = inlineText.substring(index + 1, closeBracket);
              const linkUrl = inlineText.substring(closeBracket + 2, closeParen);
              tokens.push({ type: "link", value: linkText, extra: linkUrl });
              index = closeParen + 1;
              continue;
          }
          }
        }

        // Regular character
        const currentToken = tokens[tokens.length - 1];
        if (currentToken && currentToken.type === "text") {
          currentToken.value += inlineText[index];
        } else {
          tokens.push({ type: "text", value: inlineText[index] });
        }
        index++;
      }

      return tokens.map((token, idx) => {
        switch (token.type) {
          case "bold":
            return <strong key={idx} className="font-semibold">{token.value}</strong>;
          case "italic":
            return <em key={idx} className="italic">{token.value}</em>;
          case "code":
            return <code key={idx} className="px-1.5 py-0.5 font-mono text-xs text-rose-300 bg-white/5 border border-white/10 rounded">{token.value}</code>;
          case "link":
            // Sanitize URLs to prevent javascript: schemes
            const isSafeUrl = token.extra && (token.extra.startsWith("http://") || token.extra.startsWith("https://") || token.extra.startsWith("/"));
            return (
              <a
                key={idx}
                href={isSafeUrl ? token.extra : "#"}
                target="_blank"
                rel="noreferrer noopener"
                className="text-pink-400 hover:underline inline-flex items-center gap-0.5"
              >
                {token.value}
              </a>
            );
          default:
            return token.value;
        }
      });
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Code Block check ```
      if (line.startsWith("```")) {
        flushList(`cb-flush-${i}`);
        const codeLang = line.substring(3).trim();
        const codeLines: string[] = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith("```")) {
          codeLines.push(lines[i]);
          i++;
        }
        elements.push(
          <div key={`code-block-${i}`} className="my-3 overflow-hidden rounded-xl border border-white/10 bg-black/50">
            {codeLang && (
              <div className="flex items-center justify-between px-4 py-1.5 border-b border-white/5 bg-white/5 font-mono text-[10px] text-gray-400">
                <span>{codeLang}</span>
              </div>
            )}
            <pre className="p-4 font-mono text-xs overflow-x-auto text-pink-100">
              <code>{codeLines.join("\n")}</code>
            </pre>
          </div>
        );
        continue;
      }

      // Headings
      if (line.startsWith("#")) {
        flushList(`head-flush-${i}`);
        const depth = line.match(/^#+/)?.[0].length || 1;
        const headingText = line.replace(/^#+\s*/, "");
        const innerText = parseInline(headingText);
        if (depth === 1) {
          elements.push(<h1 key={`h1-${i}`} className="text-xl font-bold tracking-tight text-white mt-3 mb-2">{innerText}</h1>);
        } else if (depth === 2) {
          elements.push(<h2 key={`h2-${i}`} className="text-lg font-bold tracking-tight text-white mt-3 mb-2">{innerText}</h2>);
        } else {
          elements.push(<h3 key={`h3-${i}`} className="text-md font-semibold tracking-tight text-white mt-2 mb-1">{innerText}</h3>);
        }
        continue;
      }

      // Lists
      if (line.startsWith("- ") || line.startsWith("* ")) {
        inList = true;
        listItems.push(line.substring(2));
        continue;
      }

      // Plain paragraph (or flush list if empty line)
      if (line === "") {
        flushList(`empty-${i}`);
        continue;
      }

      // If in list but current line isn't a list item, flush list first
      if (inList) {
        flushList(`text-${i}`);
      }

      elements.push(
        <p key={`p-${i}`} className="leading-relaxed mb-2 last:mb-0">
          {parseInline(line)}
        </p>
      );
    }

    // Wrap up any trailing list items
    flushList("trailing");

    return elements;
  };

  return <div className="space-y-1 text-sm text-gray-100">{parseMarkdown(content)}</div>;
}
