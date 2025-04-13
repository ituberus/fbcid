// smooth-navigation.js
// Add this script to all your HTML pages to enable smooth navigation without page reloads

document.addEventListener('DOMContentLoaded', function() {
  // Initialize the script
  initSmoothNavigation();
});

function initSmoothNavigation() {
  // Store the current page content for history management
  const currentPageUrl = window.location.href;
  const currentPageContent = document.documentElement.outerHTML;
  
  // Add to browser history state
  window.history.replaceState({
    url: currentPageUrl,
    content: currentPageContent
  }, document.title, currentPageUrl);
  
  // Intercept all link clicks
  document.body.addEventListener('click', function(event) {
    // Find the closest anchor tag to the clicked element
    let target = event.target;
    while (target && target !== document && target.tagName !== 'A') {
      target = target.parentNode;
    }
    
    // If we found an anchor tag
    if (target && target.tagName === 'A') {
      const href = target.getAttribute('href');
      
      // Skip if:
      // - No href attribute
      // - It's an anchor link
      // - It's an external link
      // - It has target="_blank"
      // - Special click modifiers (ctrl, shift, etc)
      if (!href || 
          href.startsWith('#') || 
          href.startsWith('http') && !href.startsWith(window.location.origin) ||
          target.getAttribute('target') === '_blank' ||
          event.ctrlKey || 
          event.shiftKey || 
          event.metaKey || 
          event.altKey) {
        return; // Let the default behavior handle it
      }
      
      // Prevent default link behavior
      event.preventDefault();
      
      // Navigate to the new page
      navigateToPage(href);
    }
  });
  
  // Handle back/forward browser navigation
  window.addEventListener('popstate', function(event) {
    if (event.state && event.state.content) {
      // Replace the current page content with the stored content
      document.open();
      document.write(event.state.content);
      document.close();
      
      // Re-initialize our navigation handler
      initSmoothNavigation();
    } else {
      // If no state is available, just navigate normally
      window.location.href = window.location.href;
    }
  });
}

function navigateToPage(url) {
  // Show some loading indicator (optional)
  const loadingIndicator = document.createElement('div');
  loadingIndicator.id = 'smooth-navigation-loader';
  loadingIndicator.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 3px; background: #007bff; z-index: 9999; transition: width 0.3s;';
  document.body.appendChild(loadingIndicator);
  
  // Animate the loading indicator
  setTimeout(() => { loadingIndicator.style.width = '40%'; }, 100);
  setTimeout(() => { loadingIndicator.style.width = '80%'; }, 300);
  
  // Fetch the new page
  fetch(url)
    .then(response => {
      if (!response.ok) {
        throw new Error('Network response was not ok');
      }
      return response.text();
    })
    .then(html => {
      // Check if the new page has our script
      if (html.includes('smooth-navigation.js') || html.includes('initSmoothNavigation')) {
        // Parse the HTML
        const parser = new DOMParser();
        const newDoc = parser.parseFromString(html, 'text/html');
        
        // Extract the new title
        const newTitle = newDoc.title || '';
        
        // Extract the new content - focus on the body content
        const newBodyContent = newDoc.body.innerHTML;
        
        // Update the page title
        document.title = newTitle;
        
        // Update the body content
        document.body.innerHTML = newBodyContent;
        
        // Update browser history
        window.history.pushState({
          url: url,
          content: html
        }, newTitle, url);
        
        // Run any scripts in the new content
        executeScripts(document.body);
        
        // Re-initialize our navigation handler
        initSmoothNavigation();
        
        // Remove loading indicator
        const loader = document.getElementById('smooth-navigation-loader');
        if (loader) {
          loader.style.width = '100%';
          setTimeout(() => {
            loader.remove();
          }, 300);
        }
      } else {
        // If the new page doesn't have our script, navigate normally
        window.location.href = url;
      }
    })
    .catch(error => {
      console.error('Error during navigation:', error);
      // Fall back to normal navigation on error
      window.location.href = url;
    });
}

// Helper function to execute scripts in the new content
function executeScripts(element) {
  // Find all script elements
  const scripts = element.querySelectorAll('script');
  
  scripts.forEach(oldScript => {
    const newScript = document.createElement('script');
    
    // Copy all attributes
    Array.from(oldScript.attributes).forEach(attr => {
      newScript.setAttribute(attr.name, attr.value);
    });
    
    // Copy inline script content
    newScript.textContent = oldScript.textContent;
    
    // Replace the old script with the new one
    if (oldScript.parentNode) {
      oldScript.parentNode.replaceChild(newScript, oldScript);
    } else {
      document.body.appendChild(newScript);
    }
  });
}
