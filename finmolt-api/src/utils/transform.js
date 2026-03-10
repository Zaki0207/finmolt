/**
 * Transform utility: snake_case keys → camelCase keys
 */

function snakeToCamel(str) {
    return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function transformKeys(obj) {
    if (Array.isArray(obj)) {
        return obj.map(transformKeys);
    }
    if (obj !== null && typeof obj === 'object' && !(obj instanceof Date)) {
        return Object.fromEntries(
            Object.entries(obj).map(([key, value]) => [
                snakeToCamel(key),
                transformKeys(value)
            ])
        );
    }
    return obj;
}

module.exports = { transformKeys };
