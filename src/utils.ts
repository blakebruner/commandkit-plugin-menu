/**
 * Transform a single component's custom_id to include action prefix and session info
 * Automatically appends item index if it's an item action
 */
export function transformComponentCustomId(
  component: any,
  actionPrefix: string,
  sessionId: string,
  itemActionNames: Set<string>,
  itemIndex?: number
): any {
  if (!component || typeof component !== "object") {
    return component
  }

  // Handle arrays
  if (Array.isArray(component)) {
    return component.map(c =>
      transformComponentCustomId(
        c,
        actionPrefix,
        sessionId,
        itemActionNames,
        itemIndex
      )
    )
  }

  // Clone the component
  const transformed: any = { ...component }

  // Transform custom_id if present
  if ("custom_id" in transformed && typeof transformed.custom_id === "string") {
    const originalId = transformed.custom_id
    const isItemAction = itemActionNames.has(originalId)

    if (isItemAction && itemIndex !== undefined) {
      // Item action: append index
      transformed.custom_id = `${actionPrefix}:${originalId}|${itemIndex}:${sessionId}`
    } else {
      // Regular action: no index
      transformed.custom_id = `${actionPrefix}:${originalId}:${sessionId}`
    }
  }

  // Recursively transform nested properties
  for (const key in transformed) {
    if (
      // biome-ignore lint/suspicious/noPrototypeBuiltins: check custom_id
      Object.prototype.hasOwnProperty.call(transformed, key) &&
      key !== "custom_id"
    ) {
      transformed[key] = transformComponentCustomId(
        transformed[key],
        actionPrefix,
        sessionId,
        itemActionNames,
        itemIndex
      )
    }
  }

  return transformed
}
