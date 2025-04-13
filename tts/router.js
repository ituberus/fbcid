document.addEventListener('DOMContentLoaded', () => {
  // Create and add the loading bar to the page
  createLoadingBar();
  
  // Initialize router
  initRouter();
  
  // Load initial content based on current URL if needed
  const currentPath = window.location.pathname + window.location.search + window.location.hash;
  loadContent(currentPath, true, false);
});

function createLoadingBar() {
  // Create loading bar container
  const loadingBarContainer = document.createElement('div');
  loadingBarContainer.id = 'loading-bar-container';
  loadingBarContainer.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 3px;
    z-index: 9999;
    pointer-events: none;
    display: none;
  `;

  // Create the actual loading bar
  const loadingBar = document.createElement('div');
  loadingBar.id = 'loading-bar';
  loadingBar.style.cssText = `
    height: 100%;
    width: 0%;
    background: linear-gradient(to right, #4cd964, #5ac8fa, #007aff, #34aadc, #5856d6, #ff2d55);
    background-size: 500% 100%;
    animation: loading-animation 2s infinite linear;
    transition: width 0.3s ease-out;
  `;

  // Add the animation style
  const style = document.createElement('style');
  style.textContent = `
    @keyframes loading-animation {
      0% { background-position: 0% 0; }
      100% { background-position: 100% 0; }
    }
  `;

  // Append elements to the DOM
  document.head.appendChild(style);
  loadingBarContainer.appendChild(loadingBar);
  document.body.appendChild(loadingBarContainer);
}

function showLoadingBar() {
  const container = document.getElementById('loading-bar-container');
  const bar = document.getElementById('loading-bar');
  
  // Reset and show loading bar
  container.style.display = 'block';
  bar.style.width = '15%'; // Start with a small width
  
  // Simulate progress
  setTimeout(() => {
    bar.style.width = '40%';
  }, 200);
  
  setTimeout(() => {
    bar.style.width = '65%';
  }, 600);
  
  setTimeout(() => {
    bar.style.width = '80%';
  }, 1200);
}

function hideLoadingBar(success = true) {
  const container = document.getElementById('loading-bar-container');
  const bar = document.getElementById('loading-bar');
  
  if (success) {
    // Complete the bar animation
    bar.style.width = '100%';
    
    // Hide after completion
    setTimeout(() => {
      container.style.display = 'none';
      bar.style.width = '0%';
    }, 300);
  } else {
    // Change to error color and then hide
    bar.style.background = '#ff3b30';
    
    setTimeout(() => {
      container.style.display = 'none';
      bar.style.width = '0%';
      
      // Reset the original gradient
      bar.style.background = 'linear-gradient(to right, #4cd964, #5ac8fa, #007aff, #34aadc, #5856d6, #ff2d55)';
      bar.style.backgroundSize = '500% 100%';
    }, 500);
  }
}

function initRouter() {
  // Handle all click events on the document
  document.addEventListener('click', (e) => {
    // Case 1: Handle buttons with data-href attribute
    if (e.target.closest('[data-href]')) {
      e.preventDefault();
      const targetElement = e.target.closest('[data-href]');
      navigateTo(targetElement.getAttribute('data-href'));
      return;
    }

    // Case 2: Handle buttons with onclick="window.location.href='...'" or similar
    if (e.target.tagName === 'BUTTON') {
      const onclickAttr = e.target.getAttribute('onclick');
      if (onclickAttr && (onclickAttr.includes('window.location.href') || 
                          onclickAttr.includes('window.location=') ||
                          onclickAttr.includes('location.href'))) {
        // Extract the URL from the onclick attribute
        const match = onclickAttr.match(/'([^']*)'|"([^"]*)"/);
        if (match) {
          const url = match[1] || match[2];
          if (isInternalUrl(url)) {
            e.preventDefault();
            e.stopPropagation(); // Stop the onclick from executing
            navigateTo(url);
            return;
          }
        }
      }
    }

    // Case 3: Handle regular links (including image links)
    const linkElement = e.target.closest('a');
    if (linkElement) {
      const href = linkElement.getAttribute('href');
      if (!href) return;

      // Check if it's an internal link
      if (isInternalUrl(href)) {
        e.preventDefault();
        navigateTo(href);
      }
    }
  }, true); // Use capture to intercept events before they reach their targets

  // Replace all onclick handlers that use window.location with our router
  replaceWindowLocationHandlers();

  // Handle browser back/forward buttons
  window.addEventListener('popstate', (e) => {
    if (e.state && e.state.url) {
      loadContent(e.state.url, false, false);
    }
  });
}

function replaceWindowLocationHandlers() {
  // Find all elements with onclick attributes that use window.location
  const elements = document.querySelectorAll('[onclick*="window.location"]');
  elements.forEach(element => {
    const onclickAttr = element.getAttribute('onclick');
    const match = onclickAttr.match(/window\.location(?:\.href)?\s*=\s*['"]([^'"]*)['"]/);
    if (match) {
      const url = match[1];
      if (isInternalUrl(url)) {
        // Replace the onclick handler
        element.setAttribute('data-original-onclick', onclickAttr);
        element.setAttribute('data-href', url);
        element.removeAttribute('onclick');
        
        // Add a new click handler
        element.addEventListener('click', (e) => {
          e.preventDefault();
          navigateTo(url);
        });
      }
    }
  });
}

function isInternalUrl(url) {
  // Skip empty URLs
  if (!url) return false;
  
  // Check if the URL is internal
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('//')) {
    // Check if it's still on the same domain
    const linkElement = document.createElement('a');
    linkElement.href = url;
    return linkElement.hostname === window.location.hostname;
  }
  
  // Skip special URLs that shouldn't be handled by the router
  return !(
    url.startsWith('#') || 
    url.startsWith('javascript:') || 
    url.startsWith('mailto:') || 
    url.startsWith('tel:') || 
    url.startsWith('sms:') || 
    url.startsWith('file:') || 
    url.includes('://') // Any other protocol
  );
}

function navigateTo(url) {
  // Normalize URL by removing any leading or trailing spaces
  url = url.trim();
  
  // Add leading slash if needed for consistency
  if (!url.startsWith('/') && !url.startsWith('http')) {
    url = '/' + url;
  }
  
  // Don't navigate if it's the current page
  const fullCurrentPath = window.location.pathname + window.location.search + window.location.hash;
  if (url === fullCurrentPath) {
    return;
  }
  
  // Update browser history
  window.history.pushState({ url }, '', url);
  
  // Load the content
  loadContent(url, true, true);
}

function loadContent(url, updateActive, showLoading = true) {
  // Ensure URL is absolute for fetch
  const absoluteUrl = url.startsWith('http') ? url : window.location.origin + url;
  
  // Show loading indicator if requested
  if (showLoading) {
    showLoadingBar();
  }
  
  // Fetch the HTML content from the requested page
  fetch(absoluteUrl)
    .then(response => {
      if (!response.ok) {
        throw new Error(`Network response was not ok: ${response.status}`);
      }
      return response.text();
    })
    .then(html => {
      // Create a temporary element to parse the HTML
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      
      // Extract the content div
      const contentElement = doc.getElementById('content');
      if (!contentElement) {
        console.error('Content element not found in the loaded page:', url);
        throw new Error('Content element not found in the loaded page. Make sure your pages have a <div id="content"> element.');
      }
      
      const newContent = contentElement.innerHTML;
      
      // Update the page content
      const currentContentElement = document.getElementById('content');
      if (currentContentElement) {
        currentContentElement.innerHTML = newContent;
      } else {
        console.error('Content element not found in the current page');
        throw new Error('Content element not found in the current page. Make sure your main layout has a <div id="content"> element.');
      }
      
      // Update page title
      document.title = doc.title;
      
      // Update active link if needed
      if (updateActive) {
        updateActiveLink(url);
      }
      
      // Execute any scripts in the new content
      executeScripts(document.getElementById('content'));
      
      // After content is loaded, replace any new window.location handlers
      replaceWindowLocationHandlers();
      
      // Hide loading bar with success
      hideLoadingBar(true);
      
      // Scroll to top
      window.scrollTo(0, 0);
      
      // Dispatch a custom event for page change
      window.dispatchEvent(new CustomEvent('pageChanged', { 
        detail: { url } 
      }));
    })
    .catch(error => {
      console.error('Error loading page:', error);
      
      // Show error in content area
      const contentElement = document.getElementById('content');
      if (contentElement) {
        contentElement.innerHTML = `
          <div style="padding: 20px; text-align: center;">
            <h2>Error Loading Page</h2>
            <p>Sorry, there was a problem loading the requested page.</p>
            <p>Error: ${error.message}</p>
            <button onclick="window.location.reload()">Reload Page</button>
          </div>
        `;
      }
      
      // Hide loading bar with error state
      hideLoadingBar(false);
    });
}

function updateActiveLink(url) {
  // Extract just the pathname from the URL
  const pathname = new URL(url, window.location.origin).pathname;
  
  // Remove active class from all navigation links
  document.querySelectorAll('a').forEach(link => {
    if (link.classList.contains('active')) {
      link.classList.remove('active');
    }
  });
  
  // Add active class to matching links
  document.querySelectorAll('a').forEach(link => {
    const linkPath = new URL(link.href, window.location.origin).pathname;
    if (linkPath === pathname) {
      link.classList.add('active');
    }
  });
}

// Function to execute scripts in dynamically loaded content
function executeScripts(container) {
  // Find all script tags in the container
  const scripts = container.querySelectorAll('script');
  
  scripts.forEach(oldScript => {
    const newScript = document.createElement('script');
    
    // Copy all attributes
    Array.from(oldScript.attributes).forEach(attr => {
      newScript.setAttribute(attr.name, attr.value);
    });
    
    // Copy the content
    newScript.textContent = oldScript.textContent;
    
    // Replace the old script with the new one
    oldScript.parentNode.replaceChild(newScript, oldScript);
  });
}
