const arrayify = (list) => {
    return [].slice.call(list, 0);
};

const rawDocumentBodyAppend = HTMLBodyElement.prototype.appendChild;

class ScopedCSS {
    static ModifiedTag = 'Symbol(style-modified-qiankun)';

    constructor() {
        const styleNode = document.createElement('style');
        rawDocumentBodyAppend.call(document.body, styleNode);

        this.swapNode = styleNode;
        this.sheet = styleNode.sheet;
        this.sheet.disabled = true;
    }

    process(styleNode, prefix = '') {
        if (ScopedCSS.ModifiedTag in styleNode) {
            return;
        }

        if (styleNode.textContent !== '') {
            const textNode = document.createTextNode(styleNode.textContent || '');
            this.swapNode.appendChild(textNode);
            const sheet = this.swapNode.sheet;
            const rules = arrayify(sheet?.cssRules ?? []);
            const css = this.rewrite(rules, prefix);
            styleNode.textContent = css;
            this.swapNode.removeChild(textNode);
            styleNode[ScopedCSS.ModifiedTag] = true;
            return;
        }

        const mutator = new MutationObserver((mutations) => {
            for (let i = 0; i < mutations.length; i += 1) {
                const mutation = mutations[i];

                if (ScopedCSS.ModifiedTag in styleNode) {
                    return;
                }

                if (mutation.type === 'childList') {
                    const sheet = styleNode.sheet;
                    const rules = arrayify(sheet?.cssRules ?? []);
                    const css = this.rewrite(rules, prefix);
                    styleNode.textContent = css;
                    styleNode[ScopedCSS.ModifiedTag] = true;
                }
            }
        });

        mutator.observe(styleNode, { childList: true });
    }

    rewrite(rules, prefix = '') {
        let css = '';

        rules.forEach((rule) => {
            switch (rule.type) {
                case RuleType.STYLE:
                    css += this.ruleStyle(rule, prefix);
                    break;
                case RuleType.MEDIA:
                    css += this.ruleMedia(rule, prefix);
                    break;
                case RuleType.SUPPORTS:
                    css += this.ruleSupport(rule, prefix);
                    break;
                default:
                    if (typeof rule.cssText === 'string') {
                        css += `${rule.cssText}`;
                    }
                    break;
            }
        });

        return css;
    }

    ruleStyle(rule, prefix = '') {
        const rootSelectorRE = /((?:[^\w\-.#]|^)(body|html|:root))/gm;
        const rootCombinationRE = /(html[^\w{[]+)/gm;

        const selector = rule.selectorText.trim();

        let cssText = '';
        if (typeof rule.cssText === 'string') {
            cssText = rule.cssText;
        }

        if (selector === 'html' || selector === 'body' || selector === ':root') {
            return cssText.replace(rootSelectorRE, prefix);
        }

        if (rootCombinationRE.test(rule.selectorText)) {
            const siblingSelectorRE = /(html[^\w{]+)(\+|~)/gm;

            if (!siblingSelectorRE.test(rule.selectorText)) {
                cssText = cssText.replace(rootCombinationRE, '');
            }
        }

        cssText = cssText.replace(/^[\s\S]+{/, (selectors) =>
            selectors.replace(/(^|,\n?)([^,]+)/g, (item, p, s) => {
                if (rootSelectorRE.test(item)) {
                    return item.replace(rootSelectorRE, (m) => {
                        const whitePrevChars = [',', '('];

                        if (m && whitePrevChars.includes(m[0])) {
                            return `${m[0]}${prefix}`;
                        }

                        return prefix;
                    });
                }

                return `${p}${prefix} ${s.replace(/^ */, '')}`;
            }),
        );

        return cssText;
    }

    ruleMedia(rule, prefix = '') {
        const css = this.rewrite(arrayify(rule.cssRules), prefix);
        return `@media ${rule.conditionText || rule.media.mediaText} {${css}}`;
    }

    ruleSupport(rule, prefix = '') {
        const css = this.rewrite(arrayify(rule.cssRules), prefix);
        return `@supports ${rule.conditionText || rule.cssText.split('{')[0]} {${css}}`;
    }
}



let processor
export const QiankunCSSRewriteAttr = 'data-qiankun';
export const process = (
    appWrapper,
    stylesheetElement,
    appName,
) => {
    // lazy singleton pattern
    if (!processor) {
        processor = new ScopedCSS();
    }

    if (stylesheetElement.tagName === 'LINK') {
        console.warn('Feature: sandbox.experimentalStyleIsolation is not support for link element yet.');
    }

    const mountDOM = appWrapper;
    if (!mountDOM) {
        return;
    }

    const tag = (mountDOM.tagName || '').toLowerCase();

    if (tag && stylesheetElement.tagName === 'STYLE') {
        const prefix = `${tag}[${QiankunCSSRewriteAttr}="${appName}"]`;
        processor.process(stylesheetElement, prefix);
    }
};
