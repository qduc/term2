const MAX_IMAGE_DATA_LEN = 100;

/**
 * Truncates base64 image data in log metadata to prevent log overflow.
 * Specifically targets messages[].content[].image and messages[].content[].image_url.url
 */
export function sanitizeLogMetadata(meta: Record<string, any>): Record<string, any> {
  if (!meta || typeof meta !== 'object') {
    return meta;
  }

  if (!Array.isArray(meta.messages)) {
    return meta;
  }

  let messagesModified = false;

  const messages = meta.messages.map((msg: any) => {
    if (!msg || typeof msg !== 'object' || !Array.isArray(msg.content)) {
      return msg;
    }

    const newContent = msg.content.map((item: any) => {
      if (!item || typeof item !== 'object') {
        return item;
      }

      let itemModified = false;
      const newItem = { ...item };

      // Handle "image" property (direct base64)
      if (typeof newItem.image === 'string' && newItem.image.startsWith('data:image/')) {
        newItem.image = truncateBase64(newItem.image);
        itemModified = true;
      }

      // Handle OpenAI-style "image_url"
      if (newItem.image_url && typeof newItem.image_url === 'object' && !Array.isArray(newItem.image_url)) {
        const imageUrl = newItem.image_url;
        if (typeof imageUrl.url === 'string' && imageUrl.url.startsWith('data:image/')) {
          newItem.image_url = {
            ...imageUrl,
            url: truncateBase64(imageUrl.url),
          };
          itemModified = true;
        }
      }

      return itemModified ? newItem : item;
    });

    const contentModified = newContent.some((item: any, index: number) => item !== msg.content[index]);
    if (!contentModified) {
      return msg;
    }

    messagesModified = true;
    return { ...msg, content: newContent };
  });

  if (!messagesModified) {
    return meta;
  }

  return {
    ...meta,
    messages,
  };
}

export function truncateImageData(meta: Record<string, any>): Record<string, any> {
  return sanitizeLogMetadata(meta);
}

function truncateBase64(data: string): string {
  if (data.length <= MAX_IMAGE_DATA_LEN) {
    return data;
  }
  return `${data.slice(0, MAX_IMAGE_DATA_LEN)}... (truncated)`;
}
