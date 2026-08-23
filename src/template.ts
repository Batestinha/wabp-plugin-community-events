export type EventTemplateNode =
  | { kind: 'text'; value: string }
  | { kind: 'variable'; token: string }
  | {
      kind: 'condition';
      token: string;
      truthy: EventTemplateNode[];
      falsy: EventTemplateNode[];
      hasElse: boolean;
    };

export interface EventTemplateValidationIssue {
  message: string;
  offset?: number | undefined;
}

export class EventTemplateSyntaxError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(message);
    this.name = 'EventTemplateSyntaxError';
    this.offset = offset;
  }
}

interface ConditionFrame {
  node: Extract<EventTemplateNode, { kind: 'condition' }>;
  parent: EventTemplateNode[];
  elseSeen: boolean;
  offset: number;
}

const VARIABLE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Parses the deliberately small Community Events template language.
 *
 * Values are never parsed as template source: callers parse the authored
 * template first and only then interpolate values into its resulting tree.
 */
export function parseEventTemplate(template: string): EventTemplateNode[] {
  const root: EventTemplateNode[] = [];
  const stack: ConditionFrame[] = [];
  let current = root;
  let textStart = 0;
  let offset = 0;

  const appendTextBefore = (end: number) => {
    if (end > textStart) {
      current.push({ kind: 'text', value: template.slice(textStart, end) });
    }
  };

  while (offset < template.length) {
    if (template.startsWith('{{', offset)) {
      appendTextBefore(offset);
      const close = template.indexOf('}}', offset + 2);
      if (close < 0) {
        throw new EventTemplateSyntaxError('unclosed template directive', offset);
      }
      const directive = template.slice(offset + 2, close).trim();
      const condition = /^#if\s+([A-Za-z][A-Za-z0-9_-]*)$/.exec(directive);
      if (condition) {
        const node: Extract<EventTemplateNode, { kind: 'condition' }> = {
          kind: 'condition',
          token: condition[1]!,
          truthy: [],
          falsy: [],
          hasElse: false
        };
        current.push(node);
        stack.push({ node, parent: current, elseSeen: false, offset });
        current = node.truthy;
      } else if (directive === 'else') {
        const frame = stack.at(-1);
        if (!frame) {
          throw new EventTemplateSyntaxError('unexpected {{else}} without an open condition', offset);
        }
        if (frame.elseSeen) {
          throw new EventTemplateSyntaxError(`duplicate {{else}} for condition {${frame.node.token}}`, offset);
        }
        frame.elseSeen = true;
        frame.node.hasElse = true;
        current = frame.node.falsy;
      } else if (directive === '/if') {
        const frame = stack.pop();
        if (!frame) {
          throw new EventTemplateSyntaxError('unexpected {{/if}} without an open condition', offset);
        }
        current = frame.parent;
      } else {
        const display = template.slice(offset, close + 2);
        throw new EventTemplateSyntaxError(`invalid template directive ${display}`, offset);
      }
      offset = close + 2;
      textStart = offset;
      continue;
    }

    if (template.startsWith('}}', offset)) {
      appendTextBefore(offset);
      throw new EventTemplateSyntaxError('unexpected template directive closing braces', offset);
    }

    if (template[offset] === '{') {
      appendTextBefore(offset);
      const close = template.indexOf('}', offset + 1);
      if (close < 0) {
        throw new EventTemplateSyntaxError('unclosed template variable', offset);
      }
      const token = template.slice(offset + 1, close);
      if (!VARIABLE_PATTERN.test(token)) {
        throw new EventTemplateSyntaxError(`invalid template variable {${token}}`, offset);
      }
      current.push({ kind: 'variable', token });
      offset = close + 1;
      textStart = offset;
      continue;
    }

    if (template[offset] === '}') {
      appendTextBefore(offset);
      throw new EventTemplateSyntaxError('unexpected template variable closing brace', offset);
    }

    offset += 1;
  }

  appendTextBefore(template.length);
  const unclosed = stack.at(-1);
  if (unclosed) {
    throw new EventTemplateSyntaxError(`unclosed {{#if ${unclosed.node.token}}} condition`, unclosed.offset);
  }
  return root;
}

export function validateEventTemplateText(
  template: string,
  allowedTokens: Iterable<string>
): EventTemplateValidationIssue[] {
  let nodes: EventTemplateNode[];
  try {
    nodes = parseEventTemplate(template);
  } catch (error) {
    if (error instanceof EventTemplateSyntaxError) {
      return [{ message: error.message, offset: error.offset }];
    }
    throw error;
  }

  const allowed = new Set(allowedTokens);
  const unknown = new Set<string>();
  visitEventTemplateNodes(nodes, (token) => {
    if (!allowed.has(token)) {
      unknown.add(token);
    }
  });
  return [...unknown].map((token) => ({
    message: `unknown template variable {${token}}`
  }));
}

export function renderEventTemplateText(
  template: string,
  values: Readonly<Record<string, string | undefined>> | ReadonlyMap<string, string>
): string {
  const nodes = parseEventTemplate(template);
  const valueFor = values instanceof Map
    ? (token: string) => values.get(token)
    : (token: string) => (values as Readonly<Record<string, string | undefined>>)[token];
  return renderEventTemplateNodes(nodes, valueFor);
}

export function renameEventTemplateToken(template: string, oldToken: string, newToken: string): string {
  if (oldToken === newToken) {
    return template;
  }
  const nodes = parseEventTemplate(template);
  renameEventTemplateNodes(nodes, oldToken, newToken);
  return serializeEventTemplateNodes(nodes);
}

function renderEventTemplateNodes(
  nodes: EventTemplateNode[],
  valueFor: (token: string) => string | undefined
): string {
  return nodes.map((node) => {
    if (node.kind === 'text') {
      return node.value;
    }
    if (node.kind === 'variable') {
      return valueFor(node.token) ?? '';
    }
    const branch = (valueFor(node.token) ?? '').length > 0 ? node.truthy : node.falsy;
    return renderEventTemplateNodes(branch, valueFor);
  }).join('');
}

function visitEventTemplateNodes(nodes: EventTemplateNode[], visit: (token: string) => void): void {
  for (const node of nodes) {
    if (node.kind === 'variable') {
      visit(node.token);
    } else if (node.kind === 'condition') {
      visit(node.token);
      visitEventTemplateNodes(node.truthy, visit);
      visitEventTemplateNodes(node.falsy, visit);
    }
  }
}

function renameEventTemplateNodes(nodes: EventTemplateNode[], oldToken: string, newToken: string): void {
  for (const node of nodes) {
    if (node.kind === 'variable' && node.token === oldToken) {
      node.token = newToken;
    } else if (node.kind === 'condition') {
      if (node.token === oldToken) {
        node.token = newToken;
      }
      renameEventTemplateNodes(node.truthy, oldToken, newToken);
      renameEventTemplateNodes(node.falsy, oldToken, newToken);
    }
  }
}

function serializeEventTemplateNodes(nodes: EventTemplateNode[]): string {
  return nodes.map((node) => {
    if (node.kind === 'text') {
      return node.value;
    }
    if (node.kind === 'variable') {
      return `{${node.token}}`;
    }
    const truthy = serializeEventTemplateNodes(node.truthy);
    const falsy = node.hasElse
      ? `{{else}}${serializeEventTemplateNodes(node.falsy)}`
      : '';
    return `{{#if ${node.token}}}${truthy}${falsy}{{/if}}`;
  }).join('');
}
