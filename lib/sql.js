'use strict';

const has = require('has');
const pattern = /^[a-zA-Z0-9_'[\]]*$/;
const patternToGetCharsInColumnKey = /\['([^)]+)']/;

const isHavingEscapeCharacter = (item) => {
    const splittedArray = item.split("['");
    const splittedArrayRest = splittedArray[1] ? splittedArray[1].split("']") : '';
    const textOutsideSquareBracket = splittedArray[0] + splittedArrayRest[1];
    if (splittedArray.length === 1) {
        return !pattern.test(item);
    }

    return !pattern.test(textOutsideSquareBracket);
};

const isHavingDotCharacter = (item) => item.includes('.');

const fomatDotContent = (content) => {
    const splittedContent = content.split('.');
    if (splittedContent.length > 1) {
        const [firstElement, ...otherElements] = splittedContent;
        const shouldFormat = isHavingEscapeCharacter(otherElements.join('.'));

        if (shouldFormat) {
            return `${firstElement}."${otherElements.join('.')}"`;
        }
    }

    return content;
};

const format = (columnName, foramtForAs) => {
    let item = columnName;
    const chartsInMapKey = patternToGetCharsInColumnKey.exec(item);
    if (chartsInMapKey) {
        const key = chartsInMapKey[1];
        if (key.includes("'")) {
            item = item.replace(key, key.replace(/'/g, "''"));
        }
    }
    const shouldFormat = isHavingEscapeCharacter(item);
    const haveDotCharacter = !chartsInMapKey && isHavingDotCharacter(item);
    const havingKeyPattern = item.includes('[');
    if (foramtForAs && (shouldFormat || havingKeyPattern)) {
        return `"${item}"`;
    } else if (haveDotCharacter) {
        return fomatDotContent(item);
    } else if (shouldFormat) {
        return `"${item}"`;
    }

    return item;
};

const escapeMap = {
    '\0': '\\0',
    "'": "\\'",
    '"': '\\"',
    '\b': '\\b',
    '\n': '\\n',
    '\r': '\\r',
    '\t': '\\t',
    '\x1a': '\\Z', // EOF
    '\\': '\\\\'
};

function escape(str) {
    const res = [];
    let char;
    const l = str.length;
    for (let i = 0; i < l; i += 1) {
        char = str[i];
        const escaped = escapeMap[char];
        if (escaped) {
            char = escaped;
        }
        res.push(char);
    }

    return res.join('');
}

function identifierToSql(ident) {
    return `${ident}`;
}

function literalToSQL(literal) {
    const { type } = literal;
    let { value } = literal;

    if (type === 'number') {
        // Do nothing
    } else if (type === 'string') {
        value = `'${escape(value)}'`;
    } else if (type === 'bool') {
        value = value ? 'TRUE' : 'FALSE';
    } else if (type === 'null') {
        value = 'NULL';
    } else if (type === 'star') {
        value = '*';
    } else if (['time', 'date', 'timestamp'].includes(type)) {
        value = `${type.toUpperCase()} '${value}'`;
    } else if (type === 'param') {
        value = `:${value}`;
    } else if (type === 'interval') {
        const sign = literal.sign ? `${literal.sign} ` : '';
        value = `INTERVAL ${sign}'${escape(value)}' ${literal.qualifier}`;
    }

    return !literal.parentheses ? value : `(${value})`;
}

let exprToSQLConvertFn = {};

function exprToSQL(expr) {
    return exprToSQLConvertFn[expr.type] ? exprToSQLConvertFn[expr.type](expr) : literalToSQL(expr);
}

function aggrToSQL(expr) {
    const { args } = expr;
    let str = exprToSQL(args.expr);
    const fnName = expr.name;

    if (fnName === 'COUNT') {
        if (has(args, 'distinct') && args.distinct !== null) {
            str = `DISTINCT ${str}`;
        }
    }

    return `${fnName}(${str})`;
}

function binaryToSQL(expr) {
    let { operator } = expr;
    let rstr = exprToSQL(expr.right);

    if (Array.isArray(rstr)) {
        if (operator === '=') {
            operator = 'IN';
        }
        if (operator === '!=') {
            operator = 'NOT IN';
        }
        if (operator === 'BETWEEN' || operator === 'NOT BETWEEN') {
            rstr = `${rstr[0]} AND ${rstr[1]}`;
        } else {
            rstr = `(${rstr.join(', ')})`;
        }
    }

    const str = `${exprToSQL(expr.left)} ${operator} ${rstr}`;

    return !expr.parentheses ? str : `(${str})`;
}

function caseToSQL(expr) {
    const res = ['CASE'];
    const conditions = expr.args;

    if (expr.expr) {
        res.push(exprToSQL(expr.expr));
    }
    const l = conditions.length;

    for (let i = 0; i < l; i += 1) {
        res.push(conditions[i].type.toUpperCase()); // when/else
        if (conditions[i].cond) {
            res.push(exprToSQL(conditions[i].cond));
            res.push('THEN');
        }
        res.push(exprToSQL(conditions[i].result));
    }

    res.push('END');

    return res.join(' ');
}

const castToSQL = (expr) =>
    `CAST(${exprToSQL(expr.expr)} AS ${expr.target.dataType}${expr.target.length ? `(${expr.target.length})` : ''})`;

function columnRefToSQL(expr) {
    let str = expr.column !== '*' ? format(expr.column) : '*';
    if (has(expr, 'table') && expr.table !== null) {
        str = `${identifierToSql(expr.table)}.${str}`;
    }

    return !expr.parentheses ? str : `(${str})`;
}

function getExprListSQL(exprList) {
    return exprList.map(exprToSQL);
}

function funcToSQL(expr) {
    const str = `${expr.name}(${exprToSQL(expr.args).join(', ')})`;

    return !expr.parentheses ? str : `(${str})`;
}

function columnsToSQL(columns) {
    return columns
        .map((column) => {
            let str = exprToSQL(column.expr);
            if (column.as !== null) {
                str += ` AS ${format(column.as, true)}`;
            }

            return str;
        })
        .join(', ');
}

function tablesToSQL(tables) {
    const baseTable = tables[0];
    const clauses = [];
    if (baseTable.type === 'dual') {
        return 'DUAL';
    }
    let str = baseTable.table ? format(baseTable.table) : exprToSQL(baseTable.expr);

    if (baseTable.db && baseTable.db !== null) {
        str = `${baseTable.db}.${str}`;
    }
    if (baseTable.as !== null) {
        str += ` AS ${format(baseTable.as, true)}`;
    }

    clauses.push(str);

    for (let i = 1; i < tables.length; i += 1) {
        const joinExpr = tables[i];

        str = joinExpr.join && joinExpr.join !== null ? ` ${joinExpr.join} ` : (str = ', ');

        if (joinExpr.table) {
            if (joinExpr.db !== null) {
                str += `${joinExpr.db}.`;
            }
            str += format(joinExpr.table);
        } else {
            str += exprToSQL(joinExpr.expr);
        }

        if (joinExpr.as !== null) {
            str += ` AS ${format(joinExpr.as, true)}`;
        }
        if (has(joinExpr, 'on') && joinExpr.on !== null) {
            str += ` ON ${exprToSQL(joinExpr.on)}`;
        }
        if (has(joinExpr, 'using')) {
            str += ` USING (${joinExpr.using.map(format).join(', ')})`;
        }

        clauses.push(str);
    }

    return clauses.join('');
}

function withToSql(withExpr) {
    return `WITH ${withExpr[0].recursive ? 'RECURSIVE ' : ''}${withExpr
        .map((cte) => {
            const name = `"${cte.name}"`;
            const columns = Array.isArray(cte.columns) ? `(${cte.columns.join(', ')})` : '';

            return `${name}${columns} AS (${exprToSQL(cte.stmt)})`;
        })
        .join(', ')}`;
}

function selectToSQL(stmt) {
    const clauses = ['SELECT'];

    if (has(stmt, 'with') && Array.isArray(stmt.with)) {
        clauses.unshift(withToSql(stmt.with));
    }
    if (has(stmt, 'options') && Array.isArray(stmt.options)) {
        clauses.push(stmt.options.join(' '));
    }
    if (has(stmt, 'distinct') && stmt.distinct !== null) {
        clauses.push(stmt.distinct);
    }
    if (stmt.columns !== '*') {
        clauses.push(columnsToSQL(stmt.columns));
    } else {
        clauses.push('*');
    }

    // FROM + joins
    if (Array.isArray(stmt.from)) {
        clauses.push('FROM', tablesToSQL(stmt.from));
    }
    if (has(stmt, 'where') && stmt.where !== null) {
        clauses.push(`WHERE ${exprToSQL(stmt.where)}`);
    }
    if (Array.isArray(stmt.groupby) && stmt.groupby.length > 0) {
        clauses.push('GROUP BY', getExprListSQL(stmt.groupby).join(', '));
    }
    if (has(stmt, 'having') && stmt.having !== null) {
        clauses.push(`HAVING ${exprToSQL(stmt.having)}`);
    }
    if (Array.isArray(stmt.orderby) && stmt.orderby.length > 0) {
        const orderExpressions = stmt.orderby.map((expr) => `${exprToSQL(expr.expr)} ${expr.type}`);
        clauses.push('ORDER BY', orderExpressions.join(', '));
    }
    if (Array.isArray(stmt.limit)) {
        clauses.push('LIMIT', stmt.limit.map(exprToSQL));
    }

    return clauses.join(' ');
}

function unaryToSQL(expr) {
    const str = `${expr.operator} ${exprToSQL(expr.expr)}`;

    return !expr.parentheses ? str : `(${str})`;
}

function unionToSQL(stmt) {
    let stmtCopy = stmt;
    const res = [selectToSQL(stmtCopy)];

    while (stmtCopy._next) {
        res.push('UNION', selectToSQL(stmtCopy._next));
        stmtCopy = stmtCopy._next;
    }

    return res.join(' ');
}

exprToSQLConvertFn = {
    aggr_func: aggrToSQL,
    binary_expr: binaryToSQL,
    case: caseToSQL,
    cast: castToSQL,
    column_ref: columnRefToSQL,
    expr_list: (expr) => {
        const str = getExprListSQL(expr.value);

        return !expr.parentheses ? str : `(${str})`;
    },
    function: funcToSQL,
    select: (expr) => {
        const str = typeof expr._next !== 'object' ? selectToSQL(expr) : unionToSQL(expr);

        return !expr.parentheses ? str : `(${str})`;
    },
    unary_expr: unaryToSQL
};

module.exports = {
    astToSQL: (ast) => unionToSQL(ast),
    format
};
